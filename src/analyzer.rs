use crate::cosmetic;
use crate::fetcher::FetchedList;
use crate::filter::Filterer;
use crate::normalizer::{normalize_hosts_line, normalize_line};
use adblock::filters::cosmetic::CosmeticFilterError;
use adblock::filters::network::NetworkFilterError;
use adblock::lists::{FilterParseError, ParseOptions, ParsedLine, parse_filter};
use rayon::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Clone, Copy, Default)]
pub struct ListStats {
    pub total_lines: u64,
    pub network_rules: u64,
    pub cosmetic_rules: u64,
    pub empty: u64,
    pub unsupported: u64,
    pub invalid: u64,
    pub scriptlets_removed: u64,
    pub redirects_removed: u64,
    /// Hosts-style lines expanded into `||domain^` network rules.
    pub hosts_converted: u64,
    /// Network rules dropped for carrying options the engine does not know.
    pub unsupported_options: u64,
    /// Cosmetic rules dropped for using syntax the engine does not support
    /// (`#$#`, `#%#`, `$$`, inline scriptlets, ...).
    pub unsupported_cosmetic: u64,
    /// Cosmetic rules rewritten or split into forms the Brave procedural
    /// engine executes (`:contains` -> `:has-text`, comma-list splitting, ...).
    pub cosmetic_transforms: u64,
}

#[derive(Default)]
struct AtomicListStats {
    total: AtomicU64,
    network: AtomicU64,
    cosmetic: AtomicU64,
    empty: AtomicU64,
    unsupported: AtomicU64,
    invalid: AtomicU64,
    scriptlets_removed: AtomicU64,
    redirects_removed: AtomicU64,
    hosts_converted: AtomicU64,
    unsupported_options: AtomicU64,
    unsupported_cosmetic: AtomicU64,
    cosmetic_transforms: AtomicU64,
}

impl AtomicListStats {
    fn snapshot(&self) -> ListStats {
        ListStats {
            total_lines: self.total.load(Ordering::Relaxed),
            network_rules: self.network.load(Ordering::Relaxed),
            cosmetic_rules: self.cosmetic.load(Ordering::Relaxed),
            empty: self.empty.load(Ordering::Relaxed),
            unsupported: self.unsupported.load(Ordering::Relaxed),
            invalid: self.invalid.load(Ordering::Relaxed),
            scriptlets_removed: self.scriptlets_removed.load(Ordering::Relaxed),
            redirects_removed: self.redirects_removed.load(Ordering::Relaxed),
            hosts_converted: self.hosts_converted.load(Ordering::Relaxed),
            unsupported_options: self.unsupported_options.load(Ordering::Relaxed),
            unsupported_cosmetic: self.unsupported_cosmetic.load(Ordering::Relaxed),
            cosmetic_transforms: self.cosmetic_transforms.load(Ordering::Relaxed),
        }
    }
}

#[derive(Default)]
pub struct Analyzer {
    opts: ParseOptions,
}

impl Analyzer {
    /// `is_hosts` selects hosts-file normalization for the list's lines.
    pub fn analyze(
        &self,
        list: &FetchedList,
        filterer: &Filterer,
        is_hosts: bool,
    ) -> (Vec<String>, ListStats) {
        let stats = AtomicListStats::default();
        let rules: Vec<String> = list
            .text
            .par_lines()
            .flat_map(|line| self.analyze_line(line, filterer, &stats, is_hosts))
            .collect();
        (rules, stats.snapshot())
    }

    /// Analyze one input line, returning every rule it contributes (normally
    /// zero or one; hosts entries can expand to several).
    fn analyze_line(
        &self,
        line: &str,
        filterer: &Filterer,
        stats: &AtomicListStats,
        is_hosts: bool,
    ) -> Vec<String> {
        stats.total.fetch_add(1, Ordering::Relaxed);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            stats.empty.fetch_add(1, Ordering::Relaxed);
            return Vec::new();
        }
        let normalized = if is_hosts {
            normalize_hosts_line(trimmed)
        } else {
            normalize_line(trimmed)
        };
        if normalized.hosts_converted {
            stats.hosts_converted.fetch_add(1, Ordering::Relaxed);
        }
        if normalized.lines.is_empty() {
            // Hosts comments and alias-only lines carry no rule.
            stats.unsupported.fetch_add(1, Ordering::Relaxed);
            return Vec::new();
        }
        normalized
            .lines
            .into_iter()
            .flat_map(|candidate| self.classify_candidates(&candidate, filterer, stats))
            .collect()
    }

    /// Run cosmetic compatibility rewriting on one candidate, then classify
    /// every produced line.
    fn classify_candidates(
        &self,
        candidate: &str,
        filterer: &Filterer,
        stats: &AtomicListStats,
    ) -> Vec<String> {
        if filterer.cosmetic_compat {
            let transformed = cosmetic::transform(candidate);
            if transformed.len() != 1 || transformed[0] != candidate {
                stats.cosmetic_transforms.fetch_add(1, Ordering::Relaxed);
                if transformed.is_empty() {
                    stats.unsupported_cosmetic.fetch_add(1, Ordering::Relaxed);
                }
            }
            return transformed
                .into_iter()
                .filter_map(|line| self.classify(&line, filterer, stats))
                .collect();
        }
        self.classify(candidate, filterer, stats)
            .into_iter()
            .collect()
    }

    fn classify(
        &self,
        line: &str,
        filterer: &Filterer,
        stats: &AtomicListStats,
    ) -> Option<String> {
        match parse_filter(line, false, self.opts) {
            Ok(ParsedLine::Network(f)) => {
                if filterer.is_unsupported_redirect(&f) {
                    stats.redirects_removed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                stats.network.fetch_add(1, Ordering::Relaxed);
                Some(line.to_owned())
            }
            Ok(ParsedLine::Cosmetic(f)) => {
                if filterer.is_scriptlet(&f) {
                    stats.scriptlets_removed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                stats.cosmetic.fetch_add(1, Ordering::Relaxed);
                Some(line.to_owned())
            }
            Err(FilterParseError::Empty) => {
                stats.empty.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(FilterParseError::Unsupported) => {
                stats.unsupported.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(FilterParseError::Network(NetworkFilterError::UnrecognisedOption)) => {
                stats.unsupported_options.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(FilterParseError::Cosmetic(e)) if is_unsupported_cosmetic_error(&e) => {
                stats.unsupported_cosmetic.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(_) => {
                stats.invalid.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }
}

/// Errors that indicate a cosmetic rule from another family that adblock-rust
/// cannot execute at all, as opposed to a simply malformed selector.
fn is_unsupported_cosmetic_error(e: &CosmeticFilterError) -> bool {
    matches!(
        e,
        CosmeticFilterError::UnsupportedSyntax
            | CosmeticFilterError::HtmlFilteringUnsupported
            | CosmeticFilterError::GenericScriptInject
            | CosmeticFilterError::InvalidScriptletArgs
            | CosmeticFilterError::GenericAction
            | CosmeticFilterError::LocationModifiersUnsupported
            | CosmeticFilterError::InvalidActionSpecifier
            | CosmeticFilterError::EmptyRule
    )
}
