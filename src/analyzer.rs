use crate::fetcher::FetchedList;
use crate::filter::Filterer;
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
        }
    }
}

#[derive(Default)]
pub struct Analyzer {
    opts: ParseOptions,
}

impl Analyzer {
    pub fn analyze(&self, list: &FetchedList, filterer: &Filterer) -> (Vec<String>, ListStats) {
        let stats = AtomicListStats::default();
        let rules: Vec<String> = list
            .text
            .par_lines()
            .filter_map(|line| self.analyze_line(line, filterer, &stats))
            .collect();
        (rules, stats.snapshot())
    }

    fn analyze_line(
        &self,
        line: &str,
        filterer: &Filterer,
        stats: &AtomicListStats,
    ) -> Option<String> {
        stats.total.fetch_add(1, Ordering::Relaxed);
        let trimmed = line.trim();
        if trimmed.is_empty() {
            stats.empty.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        match parse_filter(trimmed, false, self.opts) {
            Ok(ParsedLine::Network(f)) => {
                if filterer.is_unsupported_redirect(&f) {
                    stats.redirects_removed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                stats.network.fetch_add(1, Ordering::Relaxed);
                Some(trimmed.to_owned())
            }
            Ok(ParsedLine::Cosmetic(f)) => {
                if filterer.is_scriptlet(&f) {
                    stats.scriptlets_removed.fetch_add(1, Ordering::Relaxed);
                    return None;
                }
                stats.cosmetic.fetch_add(1, Ordering::Relaxed);
                Some(trimmed.to_owned())
            }
            Err(FilterParseError::Empty) => {
                stats.empty.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(FilterParseError::Unsupported) => {
                stats.unsupported.fetch_add(1, Ordering::Relaxed);
                None
            }
            Err(_) => {
                stats.invalid.fetch_add(1, Ordering::Relaxed);
                None
            }
        }
    }
}
