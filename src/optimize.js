// Global optimization over the merged rule set: dedup, sort, network
// subsumption, then the cosmetic cost passes. Runs last so the emitted output
// is a pass fixpoint (no rule dominated by a strictly-broader survivor).

import { subsume, subsumeScoped, tokenBucketEstimate, countWildcardDomainRules } from './network.js';
import { subsumeSelectors, subsumeProcedural, channelCounts } from './cosmetic.js';

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
  let active = unique;
  if (filter.network_optimize) {
    const [afterBasic, n1] = subsume(active);
    active = afterBasic;
    networkSubsumed = n1;
    const [afterScoped, n2] = subsumeScoped(active);
    active = afterScoped;
    scopedSubsumed = n2;
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

  return {
    rules: active,
    input_rules: inputRules,
    unique_rules: uniqueRules,
    duplicates_removed: inputRules - uniqueRules,
    cosmetic_selectors_subsumed: cosmeticSubsumed,
    procedural_subsumed: proceduralSubsumed,
    network_subsumed: networkSubsumed,
    scoped_subsumed: scopedSubsumed,
    wildcard_domain_rules: wildcardDomainRules,
    hostname_tokened: hostnameTokened,
    catch_all_estimated: catchAllEstimated,
    simple_class_id: channels[0],
    complex_token_led: channels[1],
    generic_misc: channels[2],
    hostname_hide: channels[3],
    hostname_unhide: channels[4],
    procedural: channels[5],
  };
}