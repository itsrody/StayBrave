//! Subsumption of simple network rules: drop a rule when a provably broader
//! rule already covers every request it matches.
//!
//! adblock-rust matches `||host^` / `||host/path^` rules by probing the
//! request's hostname label chain (tokenized to alphanumeric tokens, so
//! `||example.com^` is selected for any host ending in `.example.com`) and
//! then anchoring the filter hostname at a label boundary
//! (`is_anchored_by_hostname`). Two facts follow:
//!
//! * A rule whose hostname is a *label suffix* of another rule's hostname
//!   matches a strict superset of that rule's requests — `||example.com^`
//!   covers `||www.example.com^`, `||sub.www.example.com^`, etc.
//! * On the same host, a rule whose path is a *`/`-boundary prefix* of
//!   another's is broader — `||example.com/foo^` covers
//!   `||example.com/foo/bar^`, because the trailing `^` separator matches the
//!   `/` after `foo`.
//!
//! The two combine: `||example.com/foo^` also covers
//! `||www.example.com/foo/bar^`. Because both the label-suffix relation and
//! the `/`-prefix relation are transitive, removing every rule covered by any
//! strictly-broader rule leaves the unique maximal set, and a single sorted
//! greedy pass achieves it.
//!
//! Only option-less block rules (`||host^`, `||host/path^` with no `*`, `$`,
//! `@@`, or `~`) participate; anything with options, exceptions, regex or
//! entity hosts is opaque and left untouched. Matching is case-insensitive, so
//! comparisons are done on lowercased host/path.

use std::collections::{HashMap, HashSet};

/// A simple option-less block rule: `||host^` or `||host/path^`.
#[derive(Debug, Clone)]
pub struct SimpleRule {
    pub raw: String,
    pub host: String,
    pub path: String,
}

/// Parse a rule into a subsumption candidate. Returns `None` for exceptions,
/// option rules, regex/entity hosts, and anything not of the exact
/// `||host^` / `||host/path^` or `||host/` / `||host/path/` form.
pub fn parse_simple_rule(raw: &str) -> Option<SimpleRule> {
    if raw.contains('*') || raw.contains('$') || raw.contains('@') {
        return None;
    }
    let body = raw.strip_prefix("||")?;
    let (body, _terminator) = if let Some(b) = body.strip_suffix('^') {
        (b, '^')
    } else if let Some(b) = body.strip_suffix('/') {
        (b, '/')
    } else {
        return None;
    };
    let (host, path) = match body.split_once('/') {
        Some((h, p)) => (h, p.to_string()),
        None => (body, String::new()),
    };
    if !host
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return None;
    }
    Some(SimpleRule {
        raw: raw.to_string(),
        host: host.to_string(),
        path,
    })
}

/// True when a rule with path `pa` covers a rule with path `pb`: `pa` is a
/// `/`-boundary prefix of `pb` (an empty path covers every path).
fn path_prefix_covers(pa: &str, pb: &str) -> bool {
    pa.is_empty() || pb == pa || pb.starts_with(&format!("{pa}/"))
}

/// All label suffixes of a host, longest first (`a.b.com` -> `a.b.com`,
/// `b.com`, `com`).
fn label_suffixes(host: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut h = host;
    while !h.is_empty() {
        out.push(h);
        match h.find('.') {
            Some(i) => h = &h[i + 1..],
            None => h = "",
        }
    }
    out
}

/// Remove `$badfilter` pairs from a rule list.
///
/// For every rule `PATTERN$badfilter[,opts]`, find and remove the matching base
/// rule `PATTERN$opts` (the one whose options equal the badfilter's remaining
/// options).  Both the `$badfilter` rule itself and the cancelled base rule are
/// dropped, because the engine handles this interaction internally and the base
/// rule is inert — leaving it in would allow subsumption to treat a dead rule as
/// a live covering rule.
fn strip_badfilter_pairs(lines: &[String]) -> Vec<String> {
    use std::collections::HashSet;

    // Map: pattern → set of remaining-options strings cancelled by $badfilter.
    let mut cancelled: HashMap<String, HashSet<String>> = HashMap::new();

    for line in lines {
        let trimmed = line.trim();
        let Some(idx) = trimmed.rfind('$') else { continue };
        let opts_str = &trimmed[idx + 1..];
        let opts: Vec<&str> = opts_str.split(',').collect();
        if !opts.contains(&"badfilter") {
            continue;
        }
        let remaining: Vec<&str> = opts.iter().filter(|o| **o != "badfilter").copied().collect();
        let key = remaining.join(",");
        cancelled
            .entry(trimmed[..idx].to_string())
            .or_default()
            .insert(key);
    }

    if cancelled.is_empty() {
        return lines.to_vec();
    }

    lines
        .iter()
        .filter(|line| {
            let trimmed = line.trim();
            if let Some(idx) = trimmed.rfind('$') {
                let opts_str = &trimmed[idx + 1..];
                let opts: Vec<&str> = opts_str.split(',').collect();
                // Drop $badfilter rules themselves.
                if opts.contains(&"badfilter") {
                    return false;
                }
                // Drop base rules (with $) that have a matching $badfilter.
                let pattern = &trimmed[..idx];
                if let Some(cancelled_opts) = cancelled.get(pattern) {
                    let this_opts = opts.join(",");
                    if cancelled_opts.contains(&this_opts) {
                        return false;
                    }
                }
            } else {
                // No $ — this is a plain base rule. Check if it's cancelled
                // by a $badfilter with empty remaining options.
                if let Some(cancelled_opts) = cancelled.get(trimmed) {
                    if cancelled_opts.contains("") {
                        return false;
                    }
                }
            }
            true
        })
        .cloned()
        .collect()
}

/// Drop simple network rules that are redundant because a strictly-broader
/// rule already covers them. Returns the kept lines and how many were removed.
///
/// The greedy is order-safe: sorting by `(host.len, path.len)` ascending
/// guarantees every covering rule is processed before the rule it covers
/// (a broader host is strictly shorter; on the same host a broader path is
/// strictly shorter). A rule is removed iff it is covered by an earlier kept
/// rule, which by transitivity yields the maximal set.
pub fn subsume(lines: &[String]) -> (Vec<String>, u64) {
    let lines = strip_badfilter_pairs(lines);
    let mut rules: Vec<(SimpleRule, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if let Some(rule) = parse_simple_rule(line) {
            rules.push((rule, index));
        }
    }
    rules.sort_by(|a, b| {
        a.0.host
            .len()
            .cmp(&b.0.host.len())
            .then(a.0.path.len().cmp(&b.0.path.len()))
    });

    // Kept rules indexed by (lowercased) host: each entry is a path that has
    // been kept for that exact host.
    let mut kept_by_host: HashMap<String, Vec<String>> = HashMap::new();
    let mut removed: HashSet<usize> = HashSet::new();

    for (rule, index) in &rules {
        let lhost = rule.host.to_ascii_lowercase();
        let lpath = rule.path.to_ascii_lowercase();
        let covered = label_suffixes(&lhost).iter().any(|suffix| {
            kept_by_host.get(*suffix).is_some_and(|paths| {
                paths.iter().any(|p| path_prefix_covers(p, &lpath))
            })
        });
        if covered {
            removed.insert(*index);
        } else {
            kept_by_host
                .entry(lhost)
                .or_default()
                .push(rule.path.to_ascii_lowercase());
        }
    }

    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !removed.contains(i))
        .map(|(_, l)| l.clone())
        .collect();
    let removed_count = removed.len() as u64;
    (kept, removed_count)
}

/// Convert `||host^` to `||host/` to eliminate the regex flag.
///
/// The `^` separator compiles to a regex character class
/// `(?:[^\w\d\._%-]|$)` which forces lazy regex compilation and the
/// `RegexManager` hotpath.  Converting to `/` makes the pattern a plain
/// string, enabling SIMD `memmem` matching.
///
/// This is safe because hostname-anchored rules (`||host`) always match
/// against the URL portion after the hostname, which in practice always
/// starts with `/` for real HTTP requests.  The only behavioural
/// difference is bare-hostname requests without a path (e.g. `https://host`
/// without a trailing `/`), which are always redirected to `host/` by
/// servers and are negligible for ad blocking.
pub fn convert_bare_host_caret(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| {
            let trimmed = line.trim();
            if let Some(body) = trimmed.strip_prefix("||") {
                let (pattern, opts) = match body.rfind('$') {
                    Some(i) => (&body[..i], Some(&body[i..])),
                    None => (body, None),
                };
                if let Some(host) = pattern.strip_suffix('^') {
                    if !host.is_empty()
                        && !host.contains('/')
                        && !host.contains('*')
                        && !host.contains('@')
                    {
                        return match opts {
                            Some(o) => format!("||{host}/{o}"),
                            None => format!("||{host}/"),
                        };
                    }
                }
            }
            line.clone()
        })
        .collect()
}

/// Options that are pure content-type / protocol / party constraints and are
/// therefore subsets of the optionless rule's default mask
/// (`FROM_NETWORK_TYPES | FROM_HTTP | FROMHTTPS | THIRD_PARTY | FIRST_PARTY`).
///
/// A rule whose options are *exclusively* from this set is strictly covered by
/// the same pattern without any options, so it can be dropped when the
/// optionless variant is present.
///
/// `$document` is explicitly excluded: the optionless mask covers only
/// sub-resource types (`FROM_NETWORK_TYPES`) and does *not* include
/// `FROM_DOCUMENT`, so `$document`-only rules have unique semantics.
fn is_subsumable_option(opt: &str) -> bool {
    matches!(
        opt,
        "script"
            | "image"
            | "stylesheet"
            | "object"
            | "object-subrequest"
            | "media"
            | "subdocument"
            | "ping"
            | "xmlhttprequest"
            | "xhr"
            | "websocket"
            | "font"
            | "other"
            | "popup"
            | "http"
            | "https"
            | "third-party"
            | "first-party"
    )
}

/// Drop option-scoped rules (`||host/path^$script`, etc.) that are strictly
/// covered by an optionless counterpart (`||host/path^`).
///
/// The optionless rule's default mask is a superset of every combination of
/// content-type, protocol, and party-constraint options, so any rule whose
/// options are exclusively from that set is redundant.  `$document`,
/// `$important`, `$redirect`, `$removeparam`, `$domain`, `$badfilter`, and
/// other structural modifiers are *not* subsumable and are left untouched.
///
/// Returns the filtered list and the number of rules removed.
pub fn subsume_scoped(lines: &[String]) -> (Vec<String>, u64) {
    // Set of optionless rule texts (rules without any `$`).
    let optionless: HashSet<&str> = lines
        .iter()
        .filter(|l| !l.contains('$'))
        .map(|l| l.as_str())
        .collect();

    let mut removed = 0u64;
    let kept: Vec<String> = lines
        .iter()
        .filter(|line| {
            let trimmed = line.trim();
            if let Some(idx) = trimmed.rfind('$') {
                let pattern = &trimmed[..idx];
                // Only subsume if an optionless variant with the exact same
                // pattern exists.
                if optionless.contains(pattern) {
                    let opts: Vec<&str> = trimmed[idx + 1..].split(',').collect();
                    let dominated = opts.iter().all(|o| {
                        let o = o.trim();
                        o.starts_with('~') && is_subsumable_option(&o[1..])
                            || is_subsumable_option(o)
                    });
                    if dominated {
                        removed += 1;
                        return false;
                    }
                }
            }
            true
        })
        .cloned()
        .collect();
    (kept, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(lines: &[&str]) -> (Vec<String>, u64) {
        let lines: Vec<String> = lines.iter().map(|s| s.to_string()).collect();
        subsume(&lines)
    }

    #[test]
    fn parses_candidates() {
        for (raw, host, path) in [
            ("||example.com^", "example.com", ""),
            ("||example.com/foo^", "example.com", "foo"),
            ("||a.b.co.uk/path/to^", "a.b.co.uk", "path/to"),
            ("||123.abc-xyz.com^", "123.abc-xyz.com", ""),
        ] {
            let r = parse_simple_rule(raw).unwrap_or_else(|| panic!("should parse {raw}"));
            assert_eq!(r.host, host, "host of {raw}");
            assert_eq!(r.path, path, "path of {raw}");
        }
    }

    #[test]
    fn rejects_non_candidates() {
        for raw in [
            "@@||example.com^",
            "||example.com^$script",
            "||example.com*^",
            "||example.com^/foo*bar",
            "||ExAmPlE.com^",
            "||exa_mple.com^",
            "||example.com^/foo",
            "example.com",
            "||example.com^/foo^bar",
            "||example.*^",
        ] {
            assert!(
                parse_simple_rule(raw).is_none(),
                "should reject {raw}"
            );
        }
    }

    #[test]
    fn parent_host_covers_child() {
        let (kept, removed) = run(&[
            "||example.com^",
            "||www.example.com^",
            "||sub.www.example.com^",
            "||unrelated.com^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec!["||example.com^".to_string(), "||unrelated.com^".to_string()]
        );
    }

    #[test]
    fn path_prefix_covers_same_host() {
        let (kept, removed) = run(&[
            "||example.com/foo^",
            "||example.com/foo/bar^",
            "||example.com/foo/bar/baz^",
            "||example.com/foobar^",
            "||example.com/other^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec![
                "||example.com/foo^".to_string(),
                "||example.com/foobar^".to_string(),
                "||example.com/other^".to_string(),
            ]
        );
    }

    #[test]
    fn combined_host_suffix_and_path_prefix() {
        let (kept, removed) = run(&[
            "||example.com/ads^",
            "||www.example.com/ads/banner^",
            "||example.com/ads/x^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||example.com/ads^".to_string()]);
    }

    #[test]
    fn host_only_covers_any_path() {
        let (kept, removed) = run(&[
            "||example.com^",
            "||example.com/some/path^",
            "||www.example.com/other^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||example.com^".to_string()]);
    }

    #[test]
    fn unrelated_hosts_and_paths_kept() {
        let lines = [
            "||a.com/x^",
            "||a.com/y^",
            "||b.com^",
            "||c.com/x/y^",
            "||c.com/y/x^",
            "||sub.d.com/x^",
        ];
        let (kept, removed) = run(&lines);
        assert_eq!(removed, 0);
        assert_eq!(
            kept,
            lines.iter().map(|s| s.to_string()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn single_label_suffix_covers() {
        // The engine probes the full label chain, so `||com^` (hostname "com")
        // is anchored to any `.com` host via `is_anchored_by_hostname`.
        let (kept, removed) = run(&["||com^", "||example.com^", "||www.example.com/foo^"]);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||com^".to_string()]);
    }

    #[test]
    fn exceptions_and_option_rules_never_participate() {
        let lines = [
            "@@||example.com^",
            "@@||www.example.com^",
            "||example.com^$script",
            "||example.com^$domain=example.org",
            "||example.com^",
        ];
        let (kept, removed) = run(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn maximal_set_removes_chains() {
        // a.com/b^ keeps only the root even though it also covers via hosts
        // that were themselves removed.
        let (kept, removed) = run(&[
            "||a.com/b^",
            "||a.com/b/c^",
            "||sub.a.com/b/c/d^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||a.com/b^".to_string()]);
    }

    #[test]
    fn leaves_non_candidates_alone() {
        let lines = [
            "||example.com^/foo*bar^",
            "example.com",
            "||a.com^$all",
            "! comment",
            "##.ad",
        ];
        let (kept, removed) = run(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }

    #[test]
    fn badfilter_base_rule_not_used_for_subsumption() {
        // The real-world totaladblock.com pattern: a $badfilter cancels the
        // base rule, so the base rule must not survive to subsume the www variant.
        let (kept, removed) = run(&[
            "||totaladblock.com^",
            "||totaladblock.com^$badfilter",
            "||totaladblock.com^$document",
            "||totaladblock.com^$document,badfilter",
            "||www.totaladblock.com^",
        ]);
        // $badfilter pairs are stripped; only the www rule remains as a simple rule.
        assert!(kept.contains(&"||www.totaladblock.com^".to_string()));
        // The base rule and the $badfilter rule are both gone.
        assert!(!kept.contains(&"||totaladblock.com^".to_string()));
    }

    #[test]
    fn badfilter_with_options_only_cancels_matching_base() {
        // $badfilter with options should only cancel the matching base,
        // not a differently-optioned rule.
        let (kept, removed) = run(&[
            "||example.com^$document",
            "||example.com^$document,badfilter",
            "||example.com^$script",
        ]);
        assert!(kept.contains(&"||example.com^$script".to_string()));
        // The $document pair is stripped.
        assert!(!kept.contains(&"||example.com^$document".to_string()));
    }

    #[test]
    fn case_insensitive_coverage() {
        // Paths and hosts match case-insensitively, so an all-lowercase cover
        // subsumes an uppercase/non-lowercase narrower rule.
        let (kept, removed) = run(&[
            "||example.com/Foo^",
            "||example.com/foo/bar^",
            "||www.example.com/foo^",
        ]);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||example.com/Foo^".to_string()]);
    }

    #[test]
    fn bare_host_caret_converts_to_slash() {
        let input: Vec<String> = vec![
            "||example.com^".into(),
            "||example.com/foo^".into(),
            "||unrelated.com^".into(),
        ];
        let output = convert_bare_host_caret(&input);
        assert_eq!(output[0], "||example.com/");
        assert_eq!(output[1], "||example.com/foo^");
        assert_eq!(output[2], "||unrelated.com/");
    }

    #[test]
    fn bare_host_caret_with_options() {
        let input: Vec<String> = vec!["||example.com^$script".into()];
        let output = convert_bare_host_caret(&input);
        assert_eq!(output[0], "||example.com/$script");
    }

    #[test]
    fn bare_host_caret_with_path_not_converted() {
        let input: Vec<String> = vec!["||example.com/ads^".into()];
        let output = convert_bare_host_caret(&input);
        assert_eq!(output[0], "||example.com/ads^");
    }

    #[test]
    fn scoped_rule_removed_when_optionless_exists() {
        let input: Vec<String> = vec![
            "||example.com/ads^".into(),
            "||example.com/ads^$script".into(),
            "||example.com/ads^$image".into(),
        ];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["||example.com/ads^".to_string()]);
    }

    #[test]
    fn scoped_rule_kept_when_no_optionless_counterpart() {
        let input: Vec<String> = vec!["||example.com/ads^$script".into()];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 0);
        assert_eq!(kept, input);
    }

    #[test]
    fn document_option_not_subsumed() {
        let input: Vec<String> = vec![
            "||example.com/ads^".into(),
            "||example.com/ads^$document".into(),
        ];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 0);
        assert_eq!(kept, input);
    }

    #[test]
    fn important_option_not_subsumed() {
        let input: Vec<String> = vec![
            "||example.com/ads^".into(),
            "||example.com/ads^$important".into(),
        ];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 0);
        assert_eq!(kept, input);
    }

    #[test]
    fn mixed_subsumable_and_non_subsumable_opts() {
        // $document makes the whole rule non-subsumable.
        let input: Vec<String> = vec![
            "||example.com/ads^".into(),
            "||example.com/ads^$script,document".into(),
        ];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 0);
        assert_eq!(kept, input);
    }

    #[test]
    fn party_constraint_subsumed() {
        let input: Vec<String> = vec![
            "||example.com/ads^".into(),
            "||example.com/ads^$third-party".into(),
        ];
        let (kept, removed) = subsume_scoped(&input);
        assert_eq!(removed, 1);
        assert_eq!(kept, vec!["||example.com/ads^".to_string()]);
    }
}
