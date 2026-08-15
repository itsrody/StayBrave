use adblock::filters::cosmetic::CosmeticFilter;
use adblock::filters::network::{NetworkFilter, NetworkFilterMaskHelper};
use adblock::lists::{ParseOptions, ParsedLine, parse_filter};
use std::collections::HashMap;

const MAX_SAMPLES: usize = 5;

#[derive(Debug, Clone, Copy, Default)]
pub struct Diagnostics {
    pub is_network: bool,
    pub is_regex: bool,
    pub is_complete_regex: bool,
    pub with_all: bool,
    pub has_domain_opts: bool,
    pub has_modifier: bool,
    pub trimmable_wildcards: bool,
    pub mixed_case: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RewriteStats {
    pub total: u64,
    pub network: u64,
    pub cosmetic: u64,
    pub regex: u64,
    pub complete_regex: u64,
    pub with_all: u64,
    pub with_domains: u64,
    pub with_modifier: u64,
    pub trimmable_wildcards: u64,
    pub mixed_case: u64,
    pub rewritten: u64,
    pub semantic_groups: u64,
    pub merged_duplicates: u64,
    pub kept: u64,
}

#[derive(Debug)]
pub struct RewriteReport {
    pub stats: RewriteStats,
    pub rules: Vec<String>,
    pub samples: HashMap<&'static str, Vec<String>>,
}

#[derive(Default)]
pub struct Rewriter {
    opts: ParseOptions,
}

impl Rewriter {
    /// Detect inefficiency patterns in a single filter line.
    pub fn detect(&self, line: &str) -> Option<Diagnostics> {
        let trimmed = line.trim();
        match parse_filter(trimmed, false, self.opts) {
            Ok(ParsedLine::Network(f)) => {
                let opts: Vec<&str> = options_str(trimmed)
                    .map(|o| o.split(',').collect())
                    .unwrap_or_default();
                let pattern = pattern_region(trimmed);
                Some(Diagnostics {
                    is_network: true,
                    is_regex: f.is_regex(),
                    is_complete_regex: f.is_complete_regex(),
                    with_all: opts.contains(&"all"),
                    has_domain_opts: f.opt_domains.is_some() || f.opt_not_domains.is_some(),
                    has_modifier: f.modifier_option.is_some(),
                    trimmable_wildcards: has_trimmable_wildcards(pattern),
                    mixed_case: pattern.chars().any(|c| c.is_ascii_uppercase()),
                })
            }
            Ok(ParsedLine::Cosmetic(_)) => Some(Diagnostics::default()),
            Err(_) => None,
        }
    }

    /// Rewrite a single rule to its most efficient equivalent text, verified by
    /// re-parsing and comparing the full parsed semantics (mask, features,
    /// filter parts, hostname, domain options, modifier). If no candidate is
    /// provably equivalent, the original text is returned unchanged.
    pub fn rewrite_rule(&self, line: &str) -> (String, Option<Diagnostics>) {
        let trimmed = line.trim();
        let Some(diag) = self.detect(trimmed) else {
            return (trimmed.to_string(), None);
        };
        if !diag.is_network {
            return (trimmed.to_string(), Some(diag));
        }

        let Ok(ParsedLine::Network(orig)) = parse_filter(trimmed, false, self.opts) else {
            return (trimmed.to_string(), Some(diag));
        };
        let orig_sig = network_sig(&orig);
        let mut best = (self.rank_of(trimmed), trimmed.to_string());

        for cand in candidate_rewrites(trimmed) {
            if cand == trimmed {
                continue;
            }
            if let Ok(ParsedLine::Network(cf)) = parse_filter(&cand, false, self.opts) {
                if network_sig(&cf) == orig_sig {
                    let rank = self.rank_of(&cand);
                    if rank < best.0 {
                        best = (rank, cand);
                    }
                }
            }
        }

        (best.1, Some(diag))
    }

    /// Rewrite every rule and collapse semantically-equivalent rules (same mask,
    /// features, filter parts, hostname, domain options and modifier) into their
    /// single most efficient text form.
    pub fn rewrite_list(&self, rules: Vec<String>) -> RewriteReport {
        let mut stats = RewriteStats::default();
        let mut groups: HashMap<String, ((u8, u8, usize), String)> = HashMap::new();
        let mut samples: HashMap<&'static str, Vec<String>> = HashMap::new();

        for rule in rules {
            stats.total += 1;
            let (best, diag) = self.rewrite_rule(&rule);
            if let Some(d) = &diag {
                if d.is_network {
                    stats.network += 1;
                    if d.is_regex {
                        stats.regex += 1;
                        push_sample(&mut samples, "regex", &best);
                    }
                    if d.is_complete_regex {
                        stats.complete_regex += 1;
                    }
                    if d.with_all {
                        stats.with_all += 1;
                        push_sample(&mut samples, "all", &best);
                    }
                    if d.has_domain_opts {
                        stats.with_domains += 1;
                    }
                    if d.has_modifier {
                        stats.with_modifier += 1;
                    }
                    if d.trimmable_wildcards {
                        stats.trimmable_wildcards += 1;
                        push_sample(&mut samples, "wildcards", &best);
                    }
                    if d.mixed_case {
                        stats.mixed_case += 1;
                        push_sample(&mut samples, "mixed-case", &best);
                    }
                    if best != rule {
                        stats.rewritten += 1;
                        push_sample(&mut samples, "rewritten", &format!("{rule}  =>  {best}"));
                    }
                } else {
                    stats.cosmetic += 1;
                }
            }

            if let Some(sig) = self.sig_of(&best) {
                let rank = self.rank_of(&best);
                groups
                    .entry(sig)
                    .and_modify(|v| {
                        if rank < v.0 {
                            *v = (rank, best.clone());
                        }
                    })
                    .or_insert((rank, best));
            }
        }

        stats.semantic_groups = groups.len() as u64;
        stats.kept = stats.semantic_groups;
        stats.merged_duplicates = stats.total.saturating_sub(stats.semantic_groups);

        let mut out: Vec<String> = groups.into_values().map(|(_, text)| text).collect();
        out.sort();
        RewriteReport {
            stats,
            rules: out,
            samples,
        }
    }

    fn sig_of(&self, text: &str) -> Option<String> {
        match parse_filter(text, false, self.opts) {
            Ok(ParsedLine::Network(f)) => Some(network_sig(&f)),
            Ok(ParsedLine::Cosmetic(f)) => Some(cosmetic_sig(&f)),
            Err(_) => None,
        }
    }

    fn rank_of(&self, text: &str) -> (u8, u8, usize) {
        let mixed = pattern_region(text).chars().any(|c| c.is_ascii_uppercase()) as u8;
        match parse_filter(text, false, self.opts) {
            Ok(ParsedLine::Network(f)) => (f.is_regex() as u8, mixed, text.len()),
            _ => (0, mixed, text.len()),
        }
    }
}

/// Semantic signature of a parsed network filter: everything that affects
/// matching behavior, excluding the raw text and the text-derived filter id.
fn network_sig(f: &NetworkFilter) -> String {
    format!(
        "{:08x}|{:08x}|{:?}|{:?}|{:?}|{:?}|{:?}",
        f.mask.bits(),
        f.features_mask.bits(),
        f.filter.string_view(),
        f.hostname,
        f.opt_domains,
        f.opt_not_domains,
        f.modifier_option,
    )
}

/// Semantic signature of a parsed cosmetic filter, excluding raw text.
fn cosmetic_sig(f: &CosmeticFilter) -> String {
    format!(
        "{:02x}|{:?}|{:?}|{:?}|{:?}|{:?}|{:?}",
        f.mask.bits(),
        f.entities,
        f.hostnames,
        f.not_entities,
        f.not_hostnames,
        f.selector,
        f.action,
    )
}

/// Everything before the last `$` (options separator), matching the engine's
/// own `find_char_reverse(b'$', ...)` split.
fn pattern_region(raw: &str) -> &str {
    &raw[..raw.rfind('$').unwrap_or(raw.len())]
}

fn options_str(raw: &str) -> Option<&str> {
    raw.rfind('$').map(|i| &raw[i + 1..])
}

fn rebuild_with_opts(pattern: &str, opts: &[&str]) -> String {
    if opts.is_empty() {
        pattern.to_string()
    } else {
        format!("{pattern}${}", opts.join(","))
    }
}

fn is_full_regex(raw: &str) -> bool {
    let p = pattern_region(raw).trim();
    p.len() > 1 && p.starts_with('/') && p.ends_with('/')
}

fn has_trimmable_wildcards(pattern: &str) -> bool {
    let p = strip_anchors(pattern);
    let core = match p.strip_suffix('|') {
        Some(c) => c,
        None => p,
    };
    let left_anchor = p.starts_with("||") || p.starts_with('|');
    core.ends_with('*') || (!left_anchor && core.starts_with('*'))
}

fn strip_anchors(pattern: &str) -> &str {
    let p = pattern.strip_prefix("@@").unwrap_or(pattern);
    p.strip_prefix("||").unwrap_or_else(|| p.strip_prefix('|').unwrap_or(p))
}

/// Generate candidate rewrites. Every candidate is re-parsed and compared
/// against the original's semantic signature before being accepted, so unsafe
/// text manipulation can never change matching behavior.
fn candidate_rewrites(raw: &str) -> Vec<String> {
    let mut out = Vec::new();

    if let Some(idx) = raw.rfind('$') {
        let pattern = &raw[..idx];
        let opts: Vec<&str> = raw[idx + 1..].split(',').collect();
        if opts.contains(&"all") {
            // `$all` only sets the content-type mask to "everything"; when that
            // equals the option-less default (e.g. `||hostname^` rules, which
            // implicitly match all types) it is redundant. The parser also
            // treats `$all` as a superset of individual content-type options,
            // so `$script,image,all` collapses to `$all` (or nothing). Every
            // candidate below is re-parsed and signature-checked.
            let without_all: Vec<&str> = opts.iter().copied().filter(|o| *o != "all").collect();
            out.push(rebuild_with_opts(pattern, &without_all));
            out.push(rebuild_with_opts(pattern, &[]));
            let mut only_all: Vec<&str> = opts
                .iter()
                .copied()
                .filter(|o| *o != "all" && !is_content_type(o))
                .collect();
            only_all.push("all");
            out.push(rebuild_with_opts(pattern, &only_all));
            let non_content: Vec<&str> = opts
                .iter()
                .copied()
                .filter(|o| *o != "all" && !is_content_type(o))
                .collect();
            out.push(rebuild_with_opts(pattern, &non_content));
        }
    }

    if !is_full_regex(raw) {
        if pattern_region(raw).chars().any(|c| c.is_ascii_uppercase()) {
            out.push(lowercase_pattern(raw));
        }
        let trimmed = trim_wildcards(raw);
        if trimmed != raw {
            out.push(trimmed);
        }
    }

    out
}

fn is_content_type(opt: &str) -> bool {
    matches!(
        opt.trim_start_matches('~'),
        "script"
            | "image"
            | "stylesheet"
            | "object"
            | "object-subrequest"
            | "media"
            | "subdocument"
            | "document"
            | "ping"
            | "xmlhttprequest"
            | "xhr"
            | "websocket"
            | "font"
            | "other"
            | "popup"
    )
}

fn lowercase_pattern(raw: &str) -> String {
    match options_str(raw) {
        Some(opts) => format!("{}${opts}", pattern_region(raw).to_ascii_lowercase()),
        None => pattern_region(raw).to_ascii_lowercase(),
    }
}

fn trim_wildcards(raw: &str) -> String {
    let exception = raw.strip_prefix("@@");
    let s = exception.unwrap_or(raw);
    let (anchor, rest) = if let Some(r) = s.strip_prefix("||") {
        ("||", r)
    } else if let Some(r) = s.strip_prefix('|') {
        ("|", r)
    } else {
        ("", s)
    };

    let (pattern, opts) = match rest.rfind('$') {
        Some(i) => (&rest[..i], Some(&rest[i + 1..])),
        None => (rest, None),
    };
    let (core, right_anchor) = match pattern.strip_suffix('|') {
        Some(c) => (c, "|"),
        None => (pattern, ""),
    };

    let core = if anchor.is_empty() {
        core.trim_start_matches('*')
    } else {
        core
    };
    let core = core.trim_end_matches('*');

    let mut rebuilt = String::with_capacity(raw.len());
    if exception.is_some() {
        rebuilt.push_str("@@");
    }
    rebuilt.push_str(anchor);
    rebuilt.push_str(core);
    rebuilt.push_str(right_anchor);
    if let Some(o) = opts {
        rebuilt.push('$');
        rebuilt.push_str(o);
    }
    rebuilt
}

fn push_sample(map: &mut HashMap<&'static str, Vec<String>>, cat: &'static str, line: &str) {
    let v = map.entry(cat).or_default();
    if v.len() < MAX_SAMPLES {
        v.push(line.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_rewrites_accepted() {
        let rw = Rewriter::default();
        for (input, want) in [
            ("||Example.com^$script", "||example.com^$script"),
            ("*ads*", "ads"),
            ("*ads", "ads"),
            ("||example.com^$all", "||example.com^"),
            ("||example.com^$script,all", "||example.com^"),
            ("||example.com^$all,domain=example.org", "||example.com^$domain=example.org"),
        ] {
            let (got, d) = rw.rewrite_rule(input);
            assert_eq!(got, want, "for {input} (diag={d:?})");
        }
    }

    #[test]
    fn unsafe_rewrites_rejected() {
        let rw = Rewriter::default();
        for input in [
            "||Example.com^$match-case",
            "/ads/*",
            "||example.com^$script,third-party",
            "||example.com^$script",
            "||example.com^$document",
            "/ads/*$third-party,script",
        ] {
            let (got, _) = rw.rewrite_rule(input);
            assert_eq!(got, input, "should not rewrite {input}");
        }
    }
}
