//! Pre-parse normalization of filter syntax coming from other families
//! (uBlock Origin, AdGuard, Adblock Plus, and classic hosts files) into rules
//! the adblock-rust parser accepts. Every candidate produced here is still
//! handed to the real parser, so a translation can never change semantics
//! silently: if the rewritten text does not parse, it is simply dropped.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Localhost aliases present in stock hosts files that must never be blocked.
const LOCAL_ALIASES: &[&str] = &[
    "localhost",
    "ip6-localhost",
    "ip6-loopback",
    "ip6-localnet",
    "ip6-mcastprefix",
    "ip6-allnodes",
    "ip6-allrouters",
    "ip6-allhosts",
    "broadcasthost",
    "local",
];

/// Result of normalizing a single input line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Normalized {
    /// Candidate rule lines to hand to the parser. Empty means the line
    /// carries no rule worth parsing.
    pub lines: Vec<String>,
    /// True when the line was a hosts-style entry expanded into `||domain^`.
    pub hosts_converted: bool,
}

/// Normalize a single line from any supported list family.
pub fn normalize_line(line: &str) -> Normalized {
    let trimmed = line.trim();
    if let Some(ip) = trimmed.split_whitespace().next() {
        if is_ip(ip) {
            // Any IP-led line is hosts-style. Never let its raw text reach the
            // parser: the adblock-rust parser would misread `0.0.0.0 foo` as a
            // literal substring filter. Lines whose domains are all localhost
            // aliases expand to nothing.
            let domains = hosts_domains(trimmed);
            let lines: Vec<String> = domains
                .into_iter()
                .map(|d| format!("||{d}^"))
                .collect();
            return Normalized {
                hosts_converted: !lines.is_empty(),
                lines,
            };
        }
    }
    let normalized = normalize_options(trimmed);
    if normalized == trimmed {
        Normalized {
            lines: vec![trimmed.to_string()],
            hosts_converted: false,
        }
    } else {
        Normalized {
            lines: vec![normalized],
            hosts_converted: false,
        }
    }
}

/// Normalize a line from a hosts-file list (e.g. StevenBlack/hosts).
///
/// Comments are dropped outright and every IP-led or bare-domain line becomes
/// `||domain^`. Unlike [`normalize_line`], raw hosts text never reaches the
/// parser, so it cannot be misread as a literal-substring filter.
pub fn normalize_hosts_line(line: &str) -> Normalized {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('!') {
        return Normalized {
            lines: Vec::new(),
            hosts_converted: false,
        };
    }
    if let Some(ip) = trimmed.split_whitespace().next() {
        if is_ip(ip) {
            let lines: Vec<String> = hosts_domains(trimmed)
                .into_iter()
                .map(|d| format!("||{d}^"))
                .collect();
            return Normalized {
                hosts_converted: !lines.is_empty(),
                lines,
            };
        }
    }
    // Some hosts lists omit the IP and use bare-domain lines.
    if is_hostname(trimmed) {
        return Normalized {
            lines: vec![format!("||{trimmed}^")],
            hosts_converted: true,
        };
    }
    // Hybrid or unrecognized line: let the parser classify it.
    let normalized = normalize_options(trimmed);
    Normalized {
        lines: vec![normalized],
        hosts_converted: false,
    }
}

/// Map a redirect resource value (option value of `$redirect`, `$redirect-rule`
/// or `$rewrite`) to its canonical adblock-rust name. Strips the ABP
/// `abp-resource:` prefix and resolves uBO aliases to the resource names
/// shipped by adblock-rust (which are drawn from uBO's redirect-resources).
pub fn canonical_resource(name: &str) -> &str {
    let name = name.strip_prefix("abp-resource:").unwrap_or(name);
    match name {
        "1x1-transparent.gif" => "1x1.gif",
        "2x2-transparent.png" => "2x2.png",
        "3x2-transparent.png" => "3x2.png",
        "32x32-transparent.png" => "32x32.png",
        "noopjs" => "noop.js",
        "nooptext" => "noop.txt",
        "noopframe" => "noop.html",
        "noopjson" => "noop.json",
        "noopmp4-1s" => "noop-1s.mp4",
        "noopmp4-2s" => "noop-2s.mp4",
        "noopmp4-3s" => "noop-3s.mp4",
        "noopmp3-0.1s" => "noop-0.1s.mp3",
        "noopmp3-0.5s" => "noop-0.5s.mp3",
        "noopvast-2.0" => "noop-vast2.xml",
        "noopvast-3.0" => "noop-vast3.xml",
        "noopvast-4.0" => "noop-vast4.xml",
        "noopvmap-1.0" | "noop-vmap1.0.xml" => "noop-vmap1.xml",
        "blank-js" => "noop.js",
        "blank-mp4" => "noop-1s.mp4",
        "blank-mp3" => "noop-0.1s.mp3",
        "amazon-adsystem.com/aax2/amzn_ads.js" => "amazon_ads.js",
        "ampproject.org/v0.js" => "ampproject_v0.js",
        "doubleclick.net/instream/ad_status.js" => "doubleclick_instream_ad_status.js",
        "google-analytics.com/cx/api.js" => "google-analytics_cx_api.js",
        "google-analytics.com/ga.js" => "google-analytics_ga.js",
        "google-analytics.com/inpage_linkid.js" => "google-analytics_inpage_linkid.js",
        "static.chartbeat.com/chartbeat.js" => "chartbeat.js",
        "google-ima3" => "google-ima.js",
        "widgets.outbrain.com/outbrain.js" => "outbrain-widget.js",
        "popads.net.js" | "prevent-popads-net.js" => "popads.js",
        "scorecardresearch.com/beacon.js" => "scorecardresearch_beacon.js",
        other => other,
    }
}

/// Extract domains from a hosts-file line (`0.0.0.0 example.com evil.com`).
/// Callers must already have confirmed the line is IP-led.
fn hosts_domains(line: &str) -> Vec<String> {
    let mut tokens = line.split_whitespace();
    let _ = tokens.next();
    let mut domains = Vec::new();
    for token in tokens {
        if token.starts_with('#') {
            break;
        }
        let host = token.trim_end_matches('.');
        let host = host.strip_prefix("*.").unwrap_or(host);
        let host = host.to_ascii_lowercase();
        if is_hostname(&host) && !LOCAL_ALIASES.contains(&host.as_str()) {
            domains.push(host);
        }
    }
    domains
}

fn is_ip(s: &str) -> bool {
    let s = s
        .strip_prefix('[')
        .and_then(|x| x.strip_suffix(']'))
        .unwrap_or(s);
    s.parse::<Ipv4Addr>().is_ok() || s.parse::<Ipv6Addr>().is_ok()
}

fn is_hostname(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 253
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_'))
}

/// Rewrite the option section (after the last `$`) of a filter line.
fn normalize_options(raw: &str) -> String {
    let Some(idx) = raw.rfind('$') else {
        return raw.to_string();
    };
    let pattern = &raw[..idx];
    let options = &raw[idx + 1..];
    let mut rebuilt: Vec<String> = Vec::with_capacity(4);
    let mut changed = false;
    for opt in options.split(',') {
        match translate_option(opt) {
            Some(translated) => {
                changed |= translated != opt;
                rebuilt.push(translated);
            }
            None => rebuilt.push(opt.to_string()),
        }
    }
    if !changed {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    out.push_str(pattern);
    out.push('$');
    out.push_str(&rebuilt.join(","));
    out
}

/// Translate a single option token. Returns None when the token is kept as-is.
fn translate_option(opt: &str) -> Option<String> {
    // uBO shorthands: `$empty` redirects to an empty response, `$mp4` to a
    // silent video. Both map onto `$redirect` rules.
    if opt == "empty" {
        return Some("redirect=empty".to_string());
    }
    if opt == "mp4" {
        return Some("redirect=noop-1s.mp4".to_string());
    }
    let (name, value) = opt.split_once('=')?;
    if matches!(name, "redirect" | "redirect-rule" | "rewrite") {
        let canonical = canonical_resource(value);
        (canonical != value).then(|| format!("{name}={canonical}"))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adblock::lists::{ParsedLine, ParseOptions, parse_filter};

    fn parse(line: &str) -> ParsedLine<'_> {
        parse_filter(line, false, ParseOptions::default())
            .unwrap_or_else(|e| panic!("parsing {line}: {e}"))
    }

    #[test]
    fn expands_hosts_lines() {
        let n = normalize_line("0.0.0.0 example.com evil.com");
        assert!(n.hosts_converted);
        assert_eq!(n.lines, vec!["||example.com^", "||evil.com^"]);
    }

    #[test]
    fn handles_ipv6_hosts_entries() {
        let n = normalize_line("::1 tracking.example.com");
        assert!(n.hosts_converted);
        assert_eq!(n.lines, vec!["||tracking.example.com^"]);
    }

    #[test]
    fn strips_comments_and_localhost_aliases() {
        let n = normalize_line("0.0.0.0 localhost ip6-loopback ads.example.com # comment");
        assert_eq!(n.lines, vec!["||ads.example.com^"]);
    }

    #[test]
    fn all_localhost_hosts_lines_are_dropped() {
        let n = normalize_line("0.0.0.0 localhost ip6-allhosts broadcasthost");
        assert!(n.lines.is_empty());
        let n = normalize_line("ff00::0 ip6-localnet");
        assert!(n.lines.is_empty());
        let n = normalize_line("255.255.255.255 broadcasthost");
        assert!(n.lines.is_empty());
    }

    #[test]
    fn non_hosts_lines_are_not_converted() {
        let n = normalize_line("||example.com^");
        assert!(!n.hosts_converted);
        assert_eq!(n.lines, vec!["||example.com^"]);
        let n = normalize_line("# comment");
        assert!(!n.hosts_converted);
        assert_eq!(n.lines, vec!["# comment"]);
    }

    #[test]
    fn expands_ubo_shorthand_options() {
        assert_eq!(
            normalize_line("||example.com^$empty").lines,
            vec!["||example.com^$redirect=empty"]
        );
        assert_eq!(
            normalize_line("||example.com^$mp4").lines,
            vec!["||example.com^$redirect=noop-1s.mp4"]
        );
        assert_eq!(
            normalize_line("||example.com^$empty,script").lines,
            vec!["||example.com^$redirect=empty,script"]
        );
    }

    #[test]
    fn canonicalizes_redirect_values() {
        assert_eq!(
            normalize_line("||example.com^$redirect=noopjs").lines,
            vec!["||example.com^$redirect=noop.js"]
        );
        assert_eq!(
            normalize_line("||example.com^$redirect-rule=noopmp4-1s").lines,
            vec!["||example.com^$redirect-rule=noop-1s.mp4"]
        );
        assert_eq!(
            normalize_line("||example.com^$rewrite=abp-resource:blank-mp4").lines,
            vec!["||example.com^$rewrite=noop-1s.mp4"]
        );
        assert_eq!(
            normalize_line("||example.com^$rewrite=abp-resource:blank-js").lines,
            vec!["||example.com^$rewrite=noop.js"]
        );
    }

    #[test]
    fn leaves_known_syntax_untouched() {
        for line in [
            "||example.com^$redirect=noop-1s.mp4",
            "||example.com^$redirect=empty",
            "||example.com^$3p",
            "||example.com^$from=example.com",
            "||example.com^$xhr",
            "||example.com^$removeparam=x",
            "||example.com^$csp=script-src 'none'",
        ] {
            assert_eq!(normalize_line(line).lines, vec![line.to_string()]);
        }
    }

    #[test]
    fn translated_rules_still_parse() {
        for line in [
            "||example.com^$redirect=empty",
            "||example.com^$redirect=noop-1s.mp4",
            "||example.com^$rewrite=noop-1s.mp4",
            "||example.com^$redirect-rule=noop.js",
            "||example.com^$redirect=empty,script",
            "||example.com^",
        ] {
            let ParsedLine::Network(_) = parse(line) else {
                panic!("{line} should parse as network");
            };
        }
    }

    #[test]
    fn hosts_format_drops_comments() {
        for line in [
            "# Title: StevenBlack/hosts",
            "#0.0.0.0 aax-eu.amazon-adsystem.com",
            "### Version: V1.2021.05.8588",
            "! Adblock comment",
        ] {
            let n = normalize_hosts_line(line);
            assert!(n.lines.is_empty(), "should drop {line}");
            assert!(!n.hosts_converted);
        }
    }

    #[test]
    fn hosts_format_converts_ip_and_bare_domains() {
        let n = normalize_hosts_line("0.0.0.0 example.com evil.com");
        assert!(n.hosts_converted);
        assert_eq!(n.lines, vec!["||example.com^", "||evil.com^"]);

        let n = normalize_hosts_line("ads.example.net");
        assert!(n.hosts_converted);
        assert_eq!(n.lines, vec!["||ads.example.net^"]);
    }

    #[test]
    fn hosts_format_passes_hybrid_lines_through() {
        let n = normalize_hosts_line("||example.com^$script");
        assert!(!n.hosts_converted);
        assert_eq!(n.lines, vec!["||example.com^$script"]);
    }
}
