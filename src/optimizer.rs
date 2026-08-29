use crate::config::CosmeticCostConfig;
use crate::network;
use crate::rewriter::Rewriter;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct OptimizedRules {
    pub rules: Vec<String>,
    pub input_rules: usize,
    pub unique_rules: usize,
    pub duplicates_removed: usize,
    /// Cosmetic rules removed by Pass 2 (channel-aware selector subsumption:
    /// identical-selector scope cover and bare-token selector cover).
    pub cosmetic_selectors_subsumed: usize,
    /// Cosmetic rules removed by Pass 3 (procedural subsumption: plain hide
    /// over a procedural variant, and identical-procedural scope cover).
    pub procedural_subsumed: usize,
    pub network_subsumed: usize,
    pub scoped_subsumed: usize,
    pub rewritten: usize,
    pub semantic_merged: usize,
    /// Network rules restricted with an AdGuard wildcard-TLD `$domain=….*`.
    /// adblock-rust 0.13 hashes such values verbatim, so these never match.
    pub wildcard_domain_rules: usize,
    /// Estimated distribution of final network rules across the engine's token
    /// buckets: hostname-tokened (cheap) rules and catch-all bucket-0 rules
    /// (checked on every request). See [`network::token_bucket_estimate`].
    pub hostname_tokened: usize,
    pub catch_all_estimated: usize,
    /// Distribution of the final cosmetic rules across the engine's delivery
    /// channels (see [`crate::cosmetic::ChannelCounts`]).
    pub simple_class_id: usize,
    pub complex_token_led: usize,
    pub generic_misc: usize,
    pub hostname_hide: usize,
    pub hostname_unhide: usize,
    pub procedural: usize,
}

pub fn optimize(
    rules: Vec<String>,
    cosmetic_compat: bool,
    network_optimize: bool,
    cost: &CosmeticCostConfig,
) -> OptimizedRules {
    let input_rules = rules.len();
    let mut seen = HashSet::with_capacity(input_rules);
    let mut unique = Vec::with_capacity(input_rules);
    for rule in &rules {
        if !seen.contains(rule) {
            seen.insert(rule.clone());
            unique.push(rule.clone());
        }
    }
    unique.sort();
    let unique_rules = unique.len();

    let (rules, network_subsumed, rewritten, semantic_merged, scoped_subsumed) = if network_optimize
    {
        let report = Rewriter::default().rewrite_list(unique);
        let (rules, network_subsumed) = network::subsume(&report.rules);
        let (rules, scoped_subsumed) = network::subsume_scoped(&rules);
        (
            rules,
            network_subsumed,
            report.stats.rewritten as usize,
            report.stats.merged_duplicates as usize,
            scoped_subsumed,
        )
    } else {
        (unique, 0, 0, 0, 0)
    };

    // The cosmetic cost passes run on the *final* rule set. The rewriter above
    // can restructure cosmetic rules (e.g. merge identically-selectored hides
    // across host locations into one broad multi-host rule), so earlier in the
    // pipeline a cover may not exist yet; running last guarantees the emitted
    // output is a Pass 2/3 fixpoint (no dominated survivors).
    let (rules, cosmetic_selectors_subsumed) = if cosmetic_compat {
        if cost.subsume_selectors {
            crate::cosmetic::subsume_selectors(&rules)
        } else {
            crate::cosmetic::subsume(&rules)
        }
    } else {
        (rules, 0)
    };
    let (rules, procedural_subsumed) = if cosmetic_compat && cost.subsume_procedural {
        crate::cosmetic::subsume_procedural(&rules)
    } else {
        (rules, 0)
    };

    let channels = crate::cosmetic::channel_counts(&rules);
    let (hostname_tokened, catch_all_estimated) = network::token_bucket_estimate(&rules);
    let wildcard_domain_rules = network::count_wildcard_domain_rules(&rules);

    OptimizedRules {
        rules,
        input_rules,
        unique_rules,
        duplicates_removed: input_rules - unique_rules,
        cosmetic_selectors_subsumed: cosmetic_selectors_subsumed as usize,
        procedural_subsumed: procedural_subsumed as usize,
        network_subsumed: network_subsumed as usize,
        scoped_subsumed: scoped_subsumed as usize,
        rewritten,
        semantic_merged,
        wildcard_domain_rules,
        hostname_tokened,
        catch_all_estimated,
        simple_class_id: channels.simple_class_id as usize,
        complex_token_led: channels.complex_token_led as usize,
        generic_misc: channels.generic_misc as usize,
        hostname_hide: channels.hostname_hide as usize,
        hostname_unhide: channels.hostname_unhide as usize,
        procedural: channels.procedural as usize,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(
        rules: &[&str],
        cosmetic_compat: bool,
        network_optimize: bool,
    ) -> OptimizedRules {
        optimize(
            rules.iter().map(|s| s.to_string()).collect(),
            cosmetic_compat,
            network_optimize,
            &CosmeticCostConfig::default(),
        )
    }

    #[test]
    fn dedup_sort_only_by_default() {
        let o = stats(&["b", "a", "b", "c"], false, false);
        assert_eq!(o.unique_rules, 3);
        assert_eq!(o.duplicates_removed, 1);
        assert_eq!(o.rules, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn network_subsumption_gated() {
        let rules = [
            "||example.com^",
            "||www.example.com^",
            "||sub.example.com^",
        ];
        let off = stats(&rules, false, false);
        assert_eq!(off.rules.len(), 3);
        let on = stats(&rules, false, true);
        assert_eq!(on.network_subsumed, 2);
        assert_eq!(on.rules, vec!["||example.com^".to_string()]);
    }

    #[test]
    fn rewriter_lowercases_and_merges() {
        let o = stats(&["||Example.com^", "||example.com^", "||WWW.Example.com^"], false, true);
        assert!(o.rewritten > 0);
        assert_eq!(o.rules, vec!["||example.com^".to_string()]);
    }

    #[test]
    fn cosmetic_cost_passes_gated() {
        let rules = [
            "##.ad",
            "##div.ad",
            "example.com##.ad:has-text(x)",
            "example.com##.ad",
        ];
        let off = optimize(
            rules.iter().map(|s| s.to_string()).collect(),
            true,
            false,
            &CosmeticCostConfig {
                split_comma_lists: true,
                subsume_selectors: false,
                subsume_procedural: false,
            },
        );
        // Legacy identical-scope subsumption only: `example.com##.ad` is
        // unchanged (no broader-scope identical rule), everything else stays.
        assert_eq!(off.cosmetic_selectors_subsumed, 0);
        assert_eq!(off.procedural_subsumed, 0);
        assert_eq!(off.rules.len(), 4);

        let on = optimize(
            rules.iter().map(|s| s.to_string()).collect(),
            true,
            false,
            &CosmeticCostConfig::default(),
        );
        assert!(on.cosmetic_selectors_subsumed >= 1); // ##.ad covers ##div.ad
        assert_eq!(on.procedural_subsumed, 1); // example.com##.ad covers the :has-text variant
        assert_eq!(on.rules, vec!["##.ad".to_string(), "example.com##.ad".to_string()]);
    }

    #[test]
    fn channel_stats_reported() {
        let o = stats(
            &[
                "##.a",
                "##.b.c",
                "##div",
                "example.com##.x",
                "example.com#@#.y",
                "example.com##.z:has-text(w)",
            ],
            false,
            false,
        );
        assert_eq!(o.simple_class_id, 1);
        assert_eq!(o.complex_token_led, 1);
        assert_eq!(o.generic_misc, 1);
        assert_eq!(o.hostname_hide, 1);
        assert_eq!(o.hostname_unhide, 1);
        assert_eq!(o.procedural, 1);
    }
}
