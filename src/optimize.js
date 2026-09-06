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

import { subsume, subsumeScoped, tokenBucketEstimate, countWildcardDomainRules } from './network.js';
import { subsumeSelectors, subsumeProcedural, channelCounts } from './cosmetic.js';

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
  const seen = new Set();
  const unique = [];
  for (const rule of rules) {
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
  let active = unique;
  if (filter.network_optimize) {
    const [afterBasic, n1, r1] = subsume(active);
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

  const channels = channelCounts(active);
  const [hostnameTokened, catchAllEstimated] = tokenBucketEstimate(active);
  const wildcardDomainRules = countWildcardDomainRules(active);
  const firefoxExclusive = countFirefoxExclusives(active);

  return {
    rules: active,
    input_rules: inputRules,
    unique_rules: uniqueRules,
    duplicates_removed: inputRules - uniqueRules,
    cosmetic_selectors_subsumed: cosmeticSubsumed,
    procedural_subsumed: proceduralSubsumed,
    network_subsumed: networkSubsumed,
    scoped_subsumed: scopedSubsumed,
    removed_network: removedNetwork,
    pre_opt_lines: unique,
    wildcard_domain_rules: wildcardDomainRules,
    hostname_tokened: hostnameTokened,
    catch_all_estimated: catchAllEstimated,
    simple_class_id: channels[0],
    complex_token_led: channels[1],
    generic_misc: channels[2],
    hostname_hide: channels[3],
    hostname_unhide: channels[4],
    procedural: channels[5],
    firefox_exclusive: firefoxExclusive,
  };
}