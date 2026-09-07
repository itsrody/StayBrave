// Global optimization over the merged rule set: dedup, sort, network
// subsumption, then the cosmetic cost passes. Runs last so the emitted output
// is a pass fixpoint (no rule dominated by a strictly-broader survivor).
//
// The output is engineered for Firefox uBO, which is the browser where these
// capabilities exist (see uBO wiki "uBlock Origin works best on Firefox"):
// CNAME uncloaking ($cname), IP-address filtering ($ipaddress=), HTML
// filtering (##^) and response-body filtering ($replace=). Every such rule
// must survive the passes below, so post-optimization counts are tallied and
// surfaced in the writer header / CLI as a first-class metric.

import { subsume, subsumeScoped, tokenBucketEstimate, countWildcardDomainRules, subsumeSuperset, subsumeDeadByException, subsumeDeadExceptions } from './network.js';
import { subsumeSelectors, subsumeProcedural, channelCounts, deadHidesByException, deadCosmeticExceptions } from './cosmetic.js';
import { canonicalizeRules } from './rewrite.js';
import { analyzeEfficiency } from './efficiency.js';

// Rules that only Firefox uBO can execute (the filter-relevant bullet points
// of "uBlock Origin works best on Firefox"). Network options are read from the
// option list after the last `$`; extended forms from the post-`##` selector.
export function countFirefoxExclusives(lines) {
  const counts = {
    html_filters: 0,
    responseheaders: 0,
    scriptlets: 0,
    cname: 0,
    ipaddress: 0,
    csp: 0,
    replace: 0,
    uritransform: 0,
    urlskip: 0,
  };
  for (const line of lines) {
    const idx = line.lastIndexOf('$');
    if (idx !== -1) {
      for (const opt0 of line.slice(idx + 1).split(',')) {
        const opt = opt0.trim();
        if (opt === 'cname') counts.cname += 1;
        else if (opt.startsWith('ipaddress=')) counts.ipaddress += 1;
        else if (opt.startsWith('csp') || opt === 'csp') counts.csp += 1;
        else if (opt.startsWith('replace=')) counts.replace += 1;
        else if (opt === 'uritransform' || opt.startsWith('uritransform=')) counts.uritransform += 1;
        else if (opt === 'urlskip' || opt.startsWith('urlskip=')) counts.urlskip += 1;
      }
    }
    if (line.includes('#+js(')) counts.scriptlets += 1;
    if (line.includes('^responseheader')) counts.responseheaders += 1;
    if (
      (line.includes('##^') || line.includes('#@#^')) &&
      line.includes('^responseheader') === false
    ) {
      counts.html_filters += 1;
    }
  }
  return counts;
}

export function optimize(rules, filter) {
  const inputRules = rules.length;

  // Fastest-formula rewrite (provable): canonicalize uBO net-option spellings
  // *before* dedup so alias-spelled twins collapse into one rule and the
  // subsequent subsumption passes see the exact spelling uBO's engine stores.
  let active = rules;
  let canonicalizedRules = 0;
  if (filter.rewrite_canonical_options !== false) {
    [active, canonicalizedRules] = canonicalizeRules(rules);
  }

  const seen = new Set();
  const unique = [];
  for (const rule of active) {
    if (!seen.has(rule)) {
      seen.add(rule);
      unique.push(rule);
    }
  }
  unique.sort();
  const uniqueRules = unique.length;

  let networkSubsumed = 0;
  let scopedSubsumed = 0;
  const removedNetwork = [];
  if (filter.network_optimize) {
    const [afterBasic, n1, r1] = subsume(unique);
    active = afterBasic;
    networkSubsumed = n1;
    removedNetwork.push(...r1);
    const [afterScoped, n2, r2] = subsumeScoped(active);
    active = afterScoped;
    scopedSubsumed = n2;
    removedNetwork.push(...r2);
  }

  let cosmeticSubsumed = 0;
  if (filter.cosmetic_cost.subsume_selectors) {
    const [afterCos, n] = subsumeSelectors(active);
    active = afterCos;
    cosmeticSubsumed = n;
  }
  let proceduralSubsumed = 0;
  if (filter.cosmetic_cost.subsume_procedural) {
    const [afterProc, n] = subsumeProcedural(active);
    active = afterProc;
    proceduralSubsumed = n;
  }

  // Candidate superset / dead-block network removals. These are NOT committed
  // here: they carry the risk of over-approximation on domain=/party masking,
  // so the pipeline's engine gate (`certifySupersetRemovals` in lib.js) probes
  // every candidate and only certifies those whose removal preserves the
  // request outcome (superset: still blocked; dead-by-exception: still
  // unblocked by the survivor exception).
  let supersetCandidates = [];
  let deadByExceptionCandidates = [];
  if (filter.network_optimize && filter.network_superset_subsumption !== false) {
    supersetCandidates = subsumeSuperset(active).removed_lines;
    if (filter.network_dead_by_exception !== false) {
      deadByExceptionCandidates = subsumeDeadByException(active).removed_lines;
    }
  }

  // Cosmetic A/C dead-hide candidates (exception already withdraws the hide's
  // selector across its whole scope). Candidate-only; the cosmetic engine gate
  // (`certifyCosmeticDeadHides` in cosmetic-engine.js) certifies delivery is
  // preserved before the pipeline removes anything.
  let cosmeticDeadCandidates = [];
  if (filter.cosmetic_dead_hide_by_exception !== false) {
    cosmeticDeadCandidates = deadHidesByException(active).removed_lines;
  }

  // Dead invisible-rule candidates: a `@@` exception that suppresses no block
  // (`subsumeDeadExceptions`) and a `#@#` exception whose selector no hide has
  // (`deadCosmeticExceptions`). Candidate-only — the engine gates probe with
  // the candidates removed and certify each one changes no outcome.
  let deadExceptionCandidates = [];
  if (filter.network_optimize && filter.network_dead_exception !== false) {
    deadExceptionCandidates = subsumeDeadExceptions(active).removed_lines;
  }
  let cosmeticDeadExceptionCandidates = [];
  if (filter.cosmetic_dead_exception !== false) {
    cosmeticDeadExceptionCandidates = deadCosmeticExceptions(active).removed_lines;
  }

  const channels = channelCounts(active);
  const [tokened, justOrigin, catchAll] = tokenBucketEstimate(active);
  const wildcardDomainRules = countWildcardDomainRules(active);
  const firefoxExclusive = countFirefoxExclusives(active);
  const efficiency = analyzeEfficiency(active);

  return {
    rules: active,
    input_rules: inputRules,
    unique_rules: uniqueRules,
    duplicates_removed: inputRules - uniqueRules,
    canonicalized_rules: canonicalizedRules,
    cosmetic_selectors_subsumed: cosmeticSubsumed,
    procedural_subsumed: proceduralSubsumed,
    network_subsumed: networkSubsumed,
    scoped_subsumed: scopedSubsumed,
    removed_network: removedNetwork,
    pre_opt_lines: unique,
    engine_superset_candidates: supersetCandidates,
    engine_dead_candidates: deadByExceptionCandidates,
    cosmetic_dead_candidates: cosmeticDeadCandidates,
    engine_dead_exception_candidates: deadExceptionCandidates,
    cosmetic_dead_exception_candidates: cosmeticDeadExceptionCandidates,
    wildcard_domain_rules: wildcardDomainRules,
    token_buckets: { tokened, justOrigin, catchAll },
    hostname_tokened: tokened,
    just_origin: justOrigin,
    catch_all_estimated: catchAll,
    simple_class_id: channels[0],
    complex_token_led: channels[1],
    generic_misc: channels[2],
    hostname_hide: channels[3],
    hostname_unhide: channels[4],
    procedural: channels[5],
    firefox_exclusive: firefoxExclusive,
    efficiency,
  };
}

// Recompute the diagnostic fields against the final rule set (called once the
// cosmetic-engine pass and provided-list subtraction have dropped rules), so
// every number the header/CLI prints describes the shipped list.
export function refreshDiagnostics(o) {
  const channels = channelCounts(o.rules);
  const [tokened, justOrigin, catchAll] = tokenBucketEstimate(o.rules);
  o.token_buckets = { tokened, justOrigin, catchAll };
  o.hostname_tokened = tokened;
  o.just_origin = justOrigin;
  o.catch_all_estimated = catchAll;
  o.simple_class_id = channels[0];
  o.complex_token_led = channels[1];
  o.generic_misc = channels[2];
  o.hostname_hide = channels[3];
  o.hostname_unhide = channels[4];
  o.procedural = channels[5];
  o.efficiency = analyzeEfficiency(o.rules);
  o.firefox_exclusive = countFirefoxExclusives(o.rules);
  return o;
}