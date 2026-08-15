use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct OptimizedRules {
    pub rules: Vec<String>,
    pub input_rules: usize,
    pub unique_rules: usize,
    pub duplicates_removed: usize,
}

pub fn optimize(rules: Vec<String>) -> OptimizedRules {
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
    OptimizedRules {
        rules: unique,
        input_rules,
        unique_rules,
        duplicates_removed: input_rules - unique_rules,
    }
}
