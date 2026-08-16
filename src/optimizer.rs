use crate::network;
use crate::rewriter::Rewriter;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct OptimizedRules {
    pub rules: Vec<String>,
    pub input_rules: usize,
    pub unique_rules: usize,
    pub duplicates_removed: usize,
    pub cosmetic_subsumed: usize,
    pub network_subsumed: usize,
    pub rewritten: usize,
    pub semantic_merged: usize,
}

pub fn optimize(rules: Vec<String>, cosmetic_compat: bool, network_optimize: bool) -> OptimizedRules {
    let input_rules = rules.len();
    let mut seen = HashSet::with_capacity(input_rules);
    let mut unique = Vec::with_capacity(input_rules);
    for rule in rules {
        if !seen.contains(&rule) {
            seen.insert(rule.clone());
            unique.push(rule);
        }
    }
    unique.sort();
    let unique_rules = unique.len();

    let (rules, cosmetic_subsumed) = if cosmetic_compat {
        crate::cosmetic::subsume(&unique)
    } else {
        (unique, 0)
    };

    let (rules, network_subsumed, rewritten, semantic_merged) = if network_optimize {
        let report = Rewriter::default().rewrite_list(rules);
        let (rules, network_subsumed) = network::subsume(&report.rules);
        (
            rules,
            network_subsumed,
            report.stats.rewritten as usize,
            report.stats.merged_duplicates as usize,
        )
    } else {
        (rules, 0, 0, 0)
    };

    OptimizedRules {
        rules,
        input_rules,
        unique_rules,
        duplicates_removed: input_rules - unique_rules,
        cosmetic_subsumed: cosmetic_subsumed as usize,
        network_subsumed: network_subsumed as usize,
        rewritten,
        semantic_merged,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(rules: &[&str], cosmetic_compat: bool, network_optimize: bool) -> OptimizedRules {
        optimize(
            rules.iter().map(|s| s.to_string()).collect(),
            cosmetic_compat,
            network_optimize,
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
}
