//! Post-normalization rewriting of cosmetic rules into forms the procedural
//! engine Brave ships actually executes.
//!
//! Also performs same-selector host-scope subsumption: a host-scoped cosmetic
//! rule is redundant when an identical selector is already covered by a broader
//! host scope. The adblock-rust engine matches a host-scoped rule under token
//! `T` against every URL whose domain-label chain contains `T` (i.e. `T` and
//! its subdomains), so host coverage is provable:
//!
//! Ground truth was verified live against Brave 151.1.93.136 (adblock-rust
//! built without the `css-validation` feature, so every cosmetic selector
//! reaches the browser as one raw CSS string that Brave's C++ routes to its
//! procedural engine by scanning for operator prefixes):
//!
//! * Executes: plain CSS (including comma lists and `:has`/`:not`/`:is`),
//!   `:has-text`, `:matches-css`, `:matches-attr`, `:matches-path`,
//!   `:min-text-length`, `:upward`, `:xpath`, and the actions `:style`,
//!   `:remove`, `:remove-attr(name)`, `:remove-class(name)` -- chained in any
//!   combination, but only on a single simple selector.
//! * Dead (the whole rule): `:contains`, `:-abp-contains`, `:others`,
//!   `:matches-media`, `:watch-attr`, `:-abp-properties`, `:nth-ancestor`,
//!   `:matches-prop`, empty `:remove-attr()`/`:remove-class()`/`:style()`, and
//!   every comma list that contains one of the procedural/action operators.
//!
//! Transform rewrites include:
//! * `:style(display:none[!important])` stripped to a plain-CSS hide.
//! * `:contains`/`:-abp-contains` rewritten to `:has-text`.
//! * `:nth-ancestor` rewritten to `:upward`.
//! * `:min-text-length(0)` stripped (inert).
//! * `:watch-attr` stripped.
//!
//! Subsumption passes (Pass 2 and 3):
//! * Bare-token covers: single `.class`/`#id`, multi-class `.a.b`, and
//!   compound `div.ad` selectors serve as covers when they carry no
//!   pseudo-classes or attributes.
//! * Constraint-count subsumption: a procedural rule with fewer operators is
//!   always at least as broad as one with more at the same base selector.

use std::collections::{HashMap, HashSet};

/// Procedural operators and actions the Brave procedural engine executes on a
/// single simple selector. A comma list containing any of these is dead in
/// Brave, so such rules are split on top-level commas first.
const EXECUTABLE_OPS: &[&str] = &[
    ":has-text(",
    ":matches-css(",
    ":matches-attr(",
    ":matches-path(",
    ":min-text-length(",
    ":upward(",
    ":xpath(",
    ":style(",
    ":remove(",
    ":remove-attr(",
    ":remove-class(",
];

/// Operators that are dead in Brave with no safe rewrite. A rule containing
/// any of these is dropped. `:others` and `:matches-media` are routed to the
/// procedural engine but never execute there; `:-abp-properties` and
/// `:matches-prop` are not routed at all and the raw CSS is dropped by Blink.
const DROP_OPS: &[&str] = &[
    ":others(",
    ":matches-media(",
    ":-abp-properties(",
    ":matches-prop(",
];

/// Tunables for Pass 1 (format rewriting). Currently just whether pure-CSS
/// comma lists are split; kept as a struct so future format rewrites can be
/// gated independently without churning call sites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransformOptions {
    /// Split pure-CSS comma lists (`.a, .b`) into individual selectors. The
    /// engine keys a cosmetic rule on its *first* token only, so an un-split
    /// `##.a, .b` hides `.b` only when `.a` is present on the page; splitting
    /// is a correctness fix, not an optimization.
    pub split_comma_lists: bool,
}

impl Default for TransformOptions {
    fn default() -> Self {
        Self {
            split_comma_lists: true,
        }
    }
}

/// Result of transforming one cosmetic rule line.
#[derive(Debug)]
pub struct TransformOutput {
    pub lines: Vec<String>,
    /// True when a cosmetic rule was split purely on top-level commas with no
    /// procedural/action operators in any piece (the `cosmetic_transforms`
    /// counter tracks the procedural proofreading path).
    pub comma_lists_split: bool,
}

/// Transform one cosmetic rule line, returning every rule it contributes.
/// Non-cosmetic lines pass through unchanged.
pub fn transform(line: &str, opts: &TransformOptions) -> TransformOutput {
    let Some((host, sep, selector)) = split_cosmetic(line) else {
        return TransformOutput {
            lines: vec![line.to_string()],
            comma_lists_split: false,
        };
    };
    if !is_procedural(selector) {
        return split_pure_css(line, host, sep, selector, opts);
    }
    let lines = split_top_level(selector, ',')
        .into_iter()
        .filter_map(|piece| transform_piece(&piece))
        .map(|selector| format!("{host}{sep}{selector}"))
        .collect();
    TransformOutput {
        lines,
        comma_lists_split: false,
    }
}

/// Split a non-procedural comma list into individual rules. Returns the input
/// line unchanged when splitting yields fewer than two meaningful selectors.
fn split_pure_css(
    line: &str,
    host: &str,
    sep: &str,
    selector: &str,
    opts: &TransformOptions,
) -> TransformOutput {
    if !opts.split_comma_lists {
        return TransformOutput {
            lines: vec![line.to_string()],
            comma_lists_split: false,
        };
    }
    let pieces = split_top_level(selector, ',');
    if pieces.len() <= 1 {
        return TransformOutput {
            lines: vec![line.to_string()],
            comma_lists_split: false,
        };
    }
    let mut lines = Vec::new();
    for piece in pieces {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        lines.push(format!("{host}{sep}{piece}"));
    }
    if lines.len() > 1 {
        TransformOutput {
            lines,
            comma_lists_split: true,
        }
    } else {
        TransformOutput {
            lines: vec![line.to_string()],
            comma_lists_split: false,
        }
    }
}

/// Split `host##selector` into its parts. Returns `None` for non-cosmetic
/// lines and for `#?#` abp syntax, which is left for the engine to handle.
fn split_cosmetic(line: &str) -> Option<(&str, &str, &str)> {
    let idx = line.find("#@#").or_else(|| line.find("##"))?;
    let host = &line[..idx];
    if host.ends_with('?') {
        return None;
    }
    if line[idx..].starts_with("#@#") {
        Some((host, "#@#", &line[idx + 3..]))
    } else {
        Some((host, "##", &line[idx + 2..]))
    }
}

/// True when the selector contains any operator that needs attention
/// (procedural, action, or a dead operator).
pub fn is_procedural(selector: &str) -> bool {
    contains_any(selector, EXECUTABLE_OPS)
        || contains_any(selector, DROP_OPS)
        || selector.contains(":contains(")
        || selector.contains(":-abp-contains(")
        || selector.contains(":nth-ancestor(")
        || selector.contains(":watch-attr(")
        || selector.contains(":remove-attr()")
        || selector.contains(":remove-class()")
        || selector.contains(":style()")
}

/// Rewrite or drop a single simple selector (no top-level commas).
/// Returns `None` when the rule is dead in Brave.
fn transform_piece(piece: &str) -> Option<String> {
    let mut sel = piece.trim().to_string();
    if sel.is_empty() {
        return Some(sel);
    }

    // `:min-text-length(0)` is inert (every element has text length >= 0).
    sel = strip_zero_min_text_length(&sel);

    // Dead operators with a live equivalent: rewrite the argument verbatim.
    sel = rewrite_op(&sel, ":contains(", ":has-text(")?;
    sel = rewrite_op(&sel, ":-abp-contains(", ":has-text(")?;
    sel = rewrite_op(&sel, ":nth-ancestor(", ":upward(")?;

    // Dead operators with no equivalent: drop the rule.
    if contains_any(&sel, DROP_OPS)
        || sel.contains(":remove-attr()")
        || sel.contains(":remove-class()")
        || sel.contains(":style()")
    {
        return None;
    }

    // `:watch-attr` never executes; strip it and keep the rest of the rule.
    while let Some(stripped) = strip_op(&sel, ":watch-attr(") {
        sel = stripped.trim().to_string();
    }

    // Strip `:style(display:none)` — the engine already applies display:none
    // to every element matched by a `##` hide, so this action is redundant.
    // Only exact `display:none` variants are stripped; other style properties
    // (e.g., `:style(color:red)`) are kept as meaningful procedural actions.
    while let Some(stripped) = strip_style_display_none(&sel) {
        sel = stripped.trim().to_string();
    }

    if sel.is_empty() {
        return None;
    }
    Some(sel)
}

/// Replace `op(ARG)` with `replacement(ARG)` when ARG contains no nested
/// parentheses. Returns `None` when an argument is unbalanced or nested (the
/// rule cannot be translated safely and is dead in Brave).
fn rewrite_op(selector: &str, op: &str, replacement: &str) -> Option<String> {
    let mut sel = selector.to_string();
    loop {
        let Some(start) = sel.find(op) else {
            return Some(sel);
        };
        let arg_start = start + op.len();
        let arg_end = find_closing_paren(&sel, arg_start)?;
        let arg = &sel[arg_start..arg_end];
        if arg.contains('(') || arg.contains(')') {
            return None;
        }
        let rewritten = format!("{replacement}{arg})");
        sel.replace_range(start..arg_end + 1, &rewritten);
    }
}

/// Remove one `op(...)` occurrence. Returns the string with the operator
/// removed, or `None` when the operator is absent.
fn strip_op(selector: &str, op: &str) -> Option<String> {
    let start = selector.find(op)?;
    let arg_start = start + op.len();
    let arg_end = find_closing_paren(selector, arg_start)?;
    let mut out = String::with_capacity(selector.len());
    out.push_str(&selector[..start]);
    out.push_str(&selector[arg_end + 1..]);
    Some(out)
}

/// Remove every `:min-text-length(0)` — the engine requires a text length of
/// at least 0, which every element satisfies, so the operator is inert. Stops
/// at the first non-zero argument (a real threshold keeps the rule meaningful).
fn strip_zero_min_text_length(selector: &str) -> String {
    const OP: &str = ":min-text-length(";
    let mut sel = selector.to_string();
    loop {
        let Some(start) = sel.find(OP) else {
            return sel;
        };
        let arg_start = start + OP.len();
        let Some(arg_end) = find_closing_paren(&sel, arg_start) else {
            return sel;
        };
        if &sel[arg_start..arg_end] != "0" {
            return sel;
        }
        sel.replace_range(start..arg_end + 1, "");
    }
}

/// Strip one `:style(display:none)` occurrence (with optional whitespace and
/// `!important`). Returns the string with the operator removed, or `None` when
/// the operator is absent or carries a property other than `display:none`.
///
/// Only the exact `display:none` value is stripped — other style properties like
/// `:style(color:red)` are kept as meaningful procedural actions.
fn strip_style_display_none(selector: &str) -> Option<String> {
    const OP: &str = ":style(";
    let start = selector.find(OP)?;
    let arg_start = start + OP.len();
    let arg_end = find_closing_paren(selector, arg_start)?;
    let arg = selector[arg_start..arg_end].trim();
    // Normalize: remove all whitespace, then match patterns.
    let normalized: String = arg.chars().filter(|c| !c.is_whitespace()).collect();
    if normalized.eq_ignore_ascii_case("display:none")
        || normalized.eq_ignore_ascii_case("display:none!important")
    {
        let mut out = String::with_capacity(selector.len());
        out.push_str(&selector[..start]);
        out.push_str(&selector[arg_end + 1..]);
        Some(out)
    } else {
        None
    }
}

/// Index just past the `)` matching the `(` opened at `open`.
fn find_closing_paren(s: &str, open: usize) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut i = open;
    while i < bytes.len() {
        let c = bytes[i];
        if let Some(q) = quote {
            if c == b'\\' {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
        } else if c == b'\'' || c == b'"' {
            quote = Some(c);
        } else {
            match c {
                b'(' => depth += 1,
                b')' => {
                    if depth == 0 {
                        return Some(i);
                    }
                    depth -= 1;
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// True when `s` contains `sep` outside parentheses, brackets, and quoted
/// strings. Used by the verification gate to detect rules the transform should
/// have split on top-level commas.
pub fn contains_top_level(s: &str, sep: char) -> bool {
    let mut depth = 0isize;
    let mut quote: Option<char> = None;
    let mut esc = false;
    for c in s.chars() {
        if esc {
            esc = false;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                esc = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            c if c == sep && depth == 0 => return true,
            _ => {}
        }
    }
    false
}

/// Split `s` on `sep` at top level, ignoring separators inside parentheses,
/// brackets, and quoted strings. Result pieces are trimmed.
fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut start = 0usize;
    let mut depth = 0isize;
    let mut quote: Option<char> = None;
    let mut esc = false;
    for (i, c) in s.char_indices() {
        if esc {
            esc = false;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                esc = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => quote = Some(c),
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            c if c == sep && depth == 0 => {
                pieces.push(s[start..i].trim().to_string());
                start = i + 1;
            }
            _ => {}
        }
    }
    pieces.push(s[start..].trim().to_string());
    pieces
}

fn contains_any(s: &str, ops: &[&str]) -> bool {
    ops.iter().any(|op| s.contains(op))
}

/// The delivery channel the adblock-rust engine assigns a cosmetic rule,
/// mirroring `CosmeticFilterCacheBuilder::add_filter` for adblock-rust 0.13
/// (raw CSS selectors, no `css-validation` canonicalization).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Channel {
    /// Generic rule whose selector is exactly `.foo`/`#foo` —
    /// `simple_class_rules`/`simple_id_rules`. Cheapest channel.
    SimpleClassId,
    /// Generic token-led compound rule — `complex_class_rules`/
    /// `complex_id_rules`.
    ComplexTokenLed,
    /// Generic rule that is not token-led — `misc_generic_selectors`. Scanned
    /// on *every* page. Heavy.
    GenericMisc,
    /// Host-scoped plain-CSS hide — `hostname_hide`, resolved per navigation.
    HostnameHide,
    /// Host-scoped `#@#` exception — prunes by exact selector string.
    HostnameUnhide,
    /// Host-scoped procedural/action rule — JSON-evaluated per matching token.
    /// The engine rejects generic procedural rules at parse time
    /// (`GenericAction`), so every surviving procedural rule is host-scoped.
    Procedural,
}

/// Per-channel counts of the surviving cosmetic rules (report only; no rules
/// are dropped by the classifier).
#[derive(Debug, Clone, Copy, Default)]
pub struct ChannelCounts {
    pub simple_class_id: u64,
    pub complex_token_led: u64,
    pub generic_misc: u64,
    pub hostname_hide: u64,
    pub hostname_unhide: u64,
    pub procedural: u64,
}

/// Classify one cosmetic rule line into its engine delivery channel. Returns
/// `None` for non-cosmetic lines (network rules, `#?#` extended-CSS syntax,
/// comments).
pub fn classify_channel(line: &str) -> Option<Channel> {
    let (host, sep, selector) = split_cosmetic(line)?;
    if is_procedural(selector) {
        return Some(Channel::Procedural);
    }
    // Negation-only locations (`~host`) carry no positive hostname constraint:
    // the engine materializes no host-scoped hide, only a hidden generic rule
    // plus an exact-string exception for the negated hosts. So the selector is
    // delivered through the generic channel on every page.
    let has_positive = host
        .split(',')
        .map(str::trim)
        .any(|p| !p.is_empty() && !p.starts_with('~'));
    if host.is_empty() || !has_positive {
        return classify_generic(selector);
    }
    // Host-scoped rules live in the hostname maps regardless of selector
    // shape. Exception rules land in the unhide channel. `#?#` never reaches
    // here (`split_cosmetic` rejects it).
    if sep == "#@#" {
        return Some(Channel::HostnameUnhide);
    }
    Some(Channel::HostnameHide)
}

/// Classify a generic (no positive hostname) selector, following
/// `CosmeticFilterCacheBuilder::add_generic_filter`: `.`/`#`-led selectors
/// whose first class/id token covers the whole selector are simple; a longer
/// selector is complex token-led; anything else is generic-misc.
fn classify_generic(selector: &str) -> Option<Channel> {
    let Some(token) = first_class_id_token(selector) else {
        return Some(Channel::GenericMisc);
    };
    if token == selector {
        Some(Channel::SimpleClassId)
    } else {
        Some(Channel::ComplexTokenLed)
    }
}

/// First class/id token of a selector, mirroring the engine's
/// `key_from_selector` regex `^[#.][\w\\-]+` for the practical token alphabet
/// (alphanumerics plus `_`, `-`, and `\`). Escaped and esoteric class names
/// are classified per the same syntax; only the raw token prefix matters here.
pub fn first_class_id_token(selector: &str) -> Option<&str> {
    let mut chars = selector.char_indices();
    let (_, first) = chars.next()?;
    if first != '.' && first != '#' {
        return None;
    }
    let mut end = first.len_utf8();
    for (i, c) in chars {
        if c == '\\' || c == '-' || c == '_' || c.is_alphanumeric() {
            end = i + c.len_utf8();
        } else {
            break;
        }
    }
    Some(&selector[..end])
}

/// Count the surviving cosmetic rules by engine delivery channel.
pub fn channel_counts(lines: &[String]) -> ChannelCounts {
    let mut counts = ChannelCounts::default();
    for line in lines {
        match classify_channel(line) {
            Some(Channel::SimpleClassId) => counts.simple_class_id += 1,
            Some(Channel::ComplexTokenLed) => counts.complex_token_led += 1,
            Some(Channel::GenericMisc) => counts.generic_misc += 1,
            Some(Channel::HostnameHide) => counts.hostname_hide += 1,
            Some(Channel::HostnameUnhide) => counts.hostname_unhide += 1,
            Some(Channel::Procedural) => counts.procedural += 1,
            None => {}
        }
    }
    counts
}

/// A positive location token of a host-scoped cosmetic rule: either a plain
/// hostname (`example.com`) or an entity (`example.*`). Entity locations are
/// hashed from the label before `.*` and probed against a strictly broader URL
/// set (every label suffix of the hostname without its public suffix, plus the
/// bare public suffix), so `example.*` is broader than `example.com`,
/// `www.example.co.uk`, `deep.sub.example.org`, etc.
#[derive(Debug, Clone, PartialEq, Eq)]
enum LocToken {
    Host(String),
    /// Label of an `example.*` entity location (the `.*` stripped).
    Entity(String),
}

/// A host-scoped cosmetic rule that is a candidate for same-selector scope
/// subsumption.
struct HostRule {
    /// `true` for `##` hides, `false` for `#@#` exceptions.
    kind: bool,
    selector: String,
    /// Positive location tokens (already lowercased). Empty rules never reach
    /// here.
    positives: Vec<LocToken>,
    /// Index into the input lines.
    index: usize,
}

/// True when a rule token `a` provably covers a rule token `b` under the
/// engine's matching semantics: a token matches a request only if it is one of
/// the request's probed label-chain suffixes, which are the suffixes from the
/// registrable domain (via the embedded public suffix list) up to the full
/// hostname. So `a` covers `b` iff `a` is a suffix of `b` and still contains
/// the registrable domain of `b` (otherwise `a` is below the registrable domain
/// and is never probed, e.g. a public-suffix token like `com.pl` or `co.uk`).
fn covers(a: &str, b: &str, reg_of_b: &str) -> bool {
    if a == b {
        return true;
    }
    b.len() > a.len()
        && b.ends_with(a)
        && b.as_bytes()[b.len() - a.len() - 1] == b'.'
        && a.ends_with(reg_of_b)
}

/// True when the token set `a` covers `b`: every token of `b` is `a`-scoped.
fn token_sets_cover(a: &[LocToken], b: &[LocToken], reg: &HashMap<String, Option<String>>) -> bool {
    b.iter().all(|tb| {
        let reg_of_b = match tb {
            LocToken::Host(h) => reg.get(h).and_then(|r| r.as_ref()).map(|x| x.as_str()),
            LocToken::Entity(_) => None,
        };
        a.iter().any(|ta| loc_token_covers(ta, tb, reg_of_b))
    })
}

/// True when a single location token `a` provably covers a single token `b`
/// under the engine's matching semantics.
fn loc_token_covers(a: &LocToken, b: &LocToken, reg_of_b: Option<&str>) -> bool {
    match (a, b) {
        (LocToken::Host(x), LocToken::Host(y)) => covers(x, y, reg_of_b.unwrap_or_default()),
        // An entity restricts nothing about the TLD: `example.*` matches any
        // URL whose label chain (without its public suffix, or the bare public
        // suffix itself) contains the entity label.
        (LocToken::Entity(x), LocToken::Host(y)) => entity_covers_host(x, y),
        (LocToken::Entity(x), LocToken::Entity(y)) => x == y || y.ends_with(&format!(".{x}")),
        // A full hostname is always narrower than an entity: `example.com`
        // cannot substitute for `example.*` (hosts on other TLDs would be
        // lost), so it never covers one.
        (LocToken::Host(_), LocToken::Entity(_)) => false,
    }
}

/// True when entity location `entity` (the label before `.*`) covers a
/// hostname-scoped rule `hostname`: every URL matched by `hostname##sel` has
/// `entity` in the entity-probe hash set the engine computes for that URL.
///
/// That set is the label suffixes of the hostname with its public suffix
/// removed, plus the bare public suffix (`get_entity_hashes_from_labels`). So
/// `example.*` covers `example.com` (labels `example` + `com`), `example.org`,
/// `sub.example.co.uk` (labels of `sub.example`, public suffix `co.uk`), and
/// the bare public-suffix case `com` -> any `.com` host.
fn entity_covers_host(entity: &str, hostname: &str) -> bool {
    let Some(domain) = registrable_domain(hostname) else {
        return false;
    };
    let Some(dot) = domain.find('.') else {
        // Single-label domain (e.g. `localhost`): the engine derives no
        // entity labels, so nothing can cover it via an entity.
        return false;
    };
    let public_suffix = &domain[dot + 1..];
    if entity == public_suffix {
        return true;
    }
    let Some(without_ps) = hostname
        .strip_suffix(public_suffix)
        .and_then(|h| h.strip_suffix('.'))
    else {
        return false;
    };
    if without_ps.is_empty() {
        return false;
    }
    without_ps == entity || without_ps.ends_with(&format!(".{entity}"))
}

/// Registrable domain of a rule token, matching the engine's own resolver.
fn registrable_domain(token: &str) -> Option<String> {
    let url = format!("https://{token}/");
    adblock::url_parser::parse_url(&url).map(|u| u.domain().to_ascii_lowercase())
}

/// Extract the positive location tokens of a rule's host part. Returns `None`
/// when the rule cannot participate in subsumption (negations, or a
/// non-hostname location such as a regex) — such rules are opaque. Entities
/// (`part.*`) participate as `LocToken::Entity`.
fn positive_location_tokens(host: &str) -> Option<Vec<LocToken>> {
    let mut out = Vec::new();
    for part in host.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part.starts_with('~') {
            return None;
        }
        let valid_chars = |label: &str| {
            label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        };
        if let Some(label) = part.strip_suffix(".*") {
            // Entity location: only a trailing `.*` is allowed; any other `*`
            // stays opaque.
            if label.is_empty() || !valid_chars(label) {
                return None;
            }
            out.push(LocToken::Entity(label.to_ascii_lowercase()));
        } else if valid_chars(part) {
            out.push(LocToken::Host(part.to_ascii_lowercase()));
        } else {
            return None;
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// Drop cosmetic rules that are redundant because an identical selector is
/// already covered by a broader host scope, following the engine's match
/// semantics:
///
/// Among host-scoped rules with the same selector and kind (`##` vs `#@#`), a
/// rule whose location tokens are all subdomains (or entity-scoped) of another
/// rule's tokens is redundant, because the broader rule matches every URL the
/// narrower one does through the same delivery channel (host-scoped hides /
/// exceptions are resolved per navigation by probing the label chain).
///
/// Generic rules are never used as covers: generic selectors are delivered
/// through different channels (the per-page `misc_generic_selectors` scan or
/// `hidden_class_id_selectors`, both skipped under `$generichide`), so a
/// generic rule does not provably substitute for a host-scoped one.
///
/// Only plain-CSS (non-procedural) rules with pure hostname/entity constraints
/// participate; rules using negations (`~x`, `~x.*`) or procedural operators
/// are left untouched. Entity locations (`x.*`) participate only as *covers*:
/// the engine's entity probe set is broader than any full hostname's, and a
/// full hostname can never cover an entity. Returns the kept lines and how
/// many were removed.
pub fn subsume(lines: &[String]) -> (Vec<String>, u64) {
    let mut rules: Vec<HostRule> = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        let Some((host, sep, selector)) = split_cosmetic(line) else {
            continue;
        };
        if is_procedural(selector) {
            continue;
        }
        let kind = sep == "##";
        if host.is_empty() {
            continue;
        }
        let Some(positives) = positive_location_tokens(host) else {
            continue;
        };
        rules.push(HostRule {
            kind,
            selector: selector.to_string(),
            positives,
            index,
        });
    }

    let mut reg: HashMap<String, Option<String>> = HashMap::new();
    for token in rules
        .iter()
        .flat_map(|r| r.positives.iter())
        .filter_map(|t| match t {
            LocToken::Host(h) => Some(h.as_str()),
            LocToken::Entity(_) => None,
        })
        .collect::<HashSet<_>>()
    {
        reg.insert(token.to_string(), registrable_domain(token));
    }

    let mut removed: HashSet<usize> = HashSet::new();
    for rule in &rules {
        for other in rules
            .iter()
            .filter(|o| o.kind == rule.kind && o.selector == rule.selector)
        {
            if other.index == rule.index {
                continue;
            }
            if token_sets_cover(&other.positives, &rule.positives, &reg)
                && !token_sets_cover(&rule.positives, &other.positives, &reg)
            {
                removed.insert(rule.index);
                break;
            }
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

/// Combinator joining two top-level compounds of a selector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Combinator {
    /// Start of selector, or the descendant combinator (whitespace).
    NoneOrDescendant,
    /// `>` child combinator.
    Child,
    /// `+` / `~` sibling combinators. The preceding compound is *not* an
    /// ancestor of the target, so hiding it does not hide the target.
    Sibling,
}

/// Top-level (non-parenthesized) features of one selector compound.
#[derive(Debug, Default)]
struct CompoundFeatures {
    classes: Vec<String>,
    ids: Vec<String>,
    has_attr: bool,
    has_pseudo: bool,
}

/// Split a selector into its top-level compounds together with the combinator
/// that joins each compound to the previous one. Parenthesized groups
/// (`:has(...)`, `:not(...)`) and bracketed attributes are opaque atoms and
/// are never descended into. Returns `None` when the selector has unbalanced
/// groups or no compound at all.
fn split_compounds(selector: &str) -> Option<Vec<(Combinator, String)>> {
    let mut out: Vec<(Combinator, String)> = Vec::new();
    let mut cur = String::new();
    let mut combinator = Combinator::NoneOrDescendant;
    let mut depth = 0isize;
    let mut quote: Option<char> = None;
    let mut esc = false;

    for c in selector.chars() {
        if esc {
            esc = false;
            cur.push(c);
            continue;
        }
        if let Some(q) = quote {
            cur.push(c);
            if c == '\\' {
                esc = true;
            } else if c == q {
                quote = None;
            }
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            cur.push(c);
            continue;
        }
        if c == '(' || c == '[' {
            depth += 1;
            cur.push(c);
            continue;
        }
        if c == ')' || c == ']' {
            if depth == 0 {
                return None;
            }
            depth -= 1;
            cur.push(c);
            continue;
        }
        if c == '>' || c == '+' || c == '~' {
            if depth == 0 {
                let text = cur.trim();
                if !text.is_empty() {
                    out.push((combinator, text.to_string()));
                }
                cur.clear();
                combinator = if c == '>' { Combinator::Child } else { Combinator::Sibling };
            } else {
                cur.push(c);
            }
            continue;
        }
        if c.is_whitespace() && depth == 0 {
            let text = cur.trim();
            if !text.is_empty() {
                out.push((combinator, text.to_string()));
                cur.clear();
                combinator = Combinator::NoneOrDescendant;
            }
            continue;
        }
        cur.push(c);
    }
    if depth != 0 || quote.is_some() {
        return None;
    }
    let text = cur.trim();
    if !text.is_empty() {
        out.push((combinator, text.to_string()));
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

/// Extract the top-level classes/ids of a single compound, ignoring anything
/// inside parentheses or brackets.
fn compound_features(compound: &str) -> CompoundFeatures {
    let mut features = CompoundFeatures::default();
    let mut depth = 0isize;
    let mut quote: Option<char> = None;
    let mut esc = false;
    let chars: Vec<char> = compound.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        if esc {
            esc = false;
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            if c == '\\' {
                esc = true;
            } else if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '(' || c == '[' {
            if c == '[' && depth == 0 {
                features.has_attr = true;
            }
            depth += 1;
            i += 1;
            continue;
        }
        if c == ')' || c == ']' {
            if depth > 0 {
                depth -= 1;
            }
            i += 1;
            continue;
        }
        if depth == 0 && (c == '.' || c == '#' || c == ':') {
            if c == ':' {
                features.has_pseudo = true;
                i += 1;
                continue;
            }
            let start = i;
            i += 1;
            while i < chars.len()
                && (chars[i] == '\\'
                    || chars[i] == '-'
                    || chars[i] == '_'
                    || chars[i].is_alphanumeric())
            {
                i += 1;
            }
            let token: String = chars[start + 1..i].iter().collect();
            if c == '.' {
                features.classes.push(token);
            } else {
                features.ids.push(token);
            }
            continue;
        }
        i += 1;
    }
    features
}

/// Bare `##.class` / `###id` tokens that, were a bare-token hide with the same
/// scope to exist, would prove this selector's targets are hidden:
///
/// * every top-level class/id of the target (rightmost) compound — the target
///   element itself carries the token, so a bare `display: none` on it hides it
///   directly; and
/// * every top-level class/id of an *ancestor* compound that precedes only
///   descendant/child combinators — hiding that ancestor hides the whole
///   subtree it constrains.
///
/// Additionally, compound selectors that consist entirely of class/id tokens
/// (e.g., `.a.b`) or an element-type + class/id (e.g., `div.ad`) are returned
/// as bare covers when they carry no pseudo-classes or attributes. This enables
/// `##.a.b` to cover `##div.a.b`, `##.a.b > span`, and `##div.ad` to cover
/// `##div.ad > .inner`.
///
/// Compounds reached through a sibling combinator are skipped: hiding a
/// sibling never hides the target.
pub fn cover_candidates(selector: &str) -> Vec<String> {
    let Some(compounds) = split_compounds(selector) else {
        return Vec::new();
    };
    let last = compounds.len() - 1;
    let mut out = Vec::new();
    for (i, (_combinator, text)) in compounds.iter().enumerate() {
        if i != last && compounds[i + 1..].iter().any(|(c, _)| *c == Combinator::Sibling) {
            continue;
        }
        let features = compound_features(text);
        for class in &features.classes {
            out.push(format!(".{class}"));
        }
        for id in &features.ids {
            out.push(format!("#{id}"));
        }
        // Compound bare cover: when a compound has no pseudo-classes or
        // attributes, the full compound string serves as a bare cover.
        // Multi-class: `.a.b` covers `##div.a.b`, `##.a.b > span`
        // Compound: `div.ad` covers `##div.ad > .inner`, `##div.ad .banner`
        if !features.has_pseudo && !features.has_attr {
            let all_tokens = features.classes.len() + features.ids.len();
            if all_tokens > 0 {
                // Always emit the sorted class-only subset: `.a.b` from
                // `div.a.b` so that a `##.a.b` cover can match.
                let mut tokens: Vec<String> = features
                    .classes
                    .iter()
                    .map(|c| format!(".{c}"))
                    .chain(features.ids.iter().map(|id| format!("#{id}")))
                    .collect();
                tokens.sort();
                if tokens.len() > 1 {
                    out.push(tokens.join(""));
                }
                let has_element = text
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_ascii_alphabetic() && c != '.' && c != '#');
                // Full compound: element-type + class/id (e.g., div.ad)
                if has_element {
                    out.push(text.trim().to_string());
                }
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Compute the bare cover tokens for a rule's selector. These are the tokens
/// that, if present in `cover_candidates()` of a victim, would prove the
/// victim is covered by this rule.
fn compute_bare_covers(selector: &str) -> Vec<String> {
    let mut covers = Vec::new();
    // Single class/id: `.ad` or `#id` as the entire selector.
    if let Some(tok) = first_class_id_token(selector) {
        if tok == selector {
            covers.push(tok.to_string());
        }
    }
    // Multi-class/compound bare covers only for single-compound selectors
    // (no combinators). Descendant/child selectors like `.a .ad` are more
    // specific than the bare token and cannot serve as covers.
    let Some(compounds) = split_compounds(selector) else {
        return covers;
    };
    if compounds.len() != 1 {
        return covers;
    }
    if let Some((_combinator, text)) = compounds.first() {
        let features = compound_features(text);
        if !features.has_pseudo && !features.has_attr {
            let all_tokens = features.classes.len() + features.ids.len();
            let has_element = text
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() && c != '.' && c != '#');
            if all_tokens > 0 && !has_element {
                let mut tokens: Vec<String> = features
                    .classes
                    .iter()
                    .map(|c| format!(".{c}"))
                    .chain(features.ids.iter().map(|id| format!("#{id}")))
                    .collect();
                tokens.sort();
                covers.push(tokens.join(""));
            }
            if all_tokens > 0 && has_element {
                covers.push(text.trim().to_string());
            }
        }
    }
    covers.sort();
    covers.dedup();
    covers
}

/// A cosmetic rule candidate for Pass-2 selector subsumption.
struct SelectorRule<'a> {
    index: usize,
    /// `true` for `##` hides, `false` for `#@#` exceptions.
    is_hide: bool,
    selector: &'a str,
    /// Positive location tokens. `Some(vec![])` when generic (all pages);
    /// `None` when the scope is opaque (negations, non-hostname locations).
    positives: Option<Vec<LocToken>>,
    /// Bare selector strings when this rule can act as a cover. May contain
    /// multiple forms: single `.class`/`#id`, multi-class `.a.b`, and
    /// compound `div.ad`.
    bare: Vec<String>,
}

/// True when a rule scope `cover` provably matches every URL that `victim`
/// does, under the engine's host-scoped matching semantics. Generic rules
/// (an empty token set) match every page and only cover other generic rules —
/// a generic rule is delivered through the generic channels, which pages can
/// disable with `$generichide`, so it can never substitute for a host-scoped
/// rule (hostname manifolds are immune to `$generichide`).
fn scope_covers(
    cover: &[LocToken],
    victim: &[LocToken],
    reg: &HashMap<String, Option<String>>,
) -> bool {
    match (cover.is_empty(), victim.is_empty()) {
        (true, true) => true,
        (true, false) => false, // generic never covers host-scoped (`$generichide`)
        (false, true) => false, // a host-scoped rule never covers all pages
        (false, false) => token_sets_cover(cover, victim, reg),
    }
}

/// Registrable-domain cache for every host token seen across the rules.
fn build_scope_registry(rules: &[SelectorRule]) -> HashMap<String, Option<String>> {
    let mut reg: HashMap<String, Option<String>> = HashMap::new();
    for token in rules
        .iter()
        .flat_map(|r| r.positives.iter().flatten())
        .filter_map(|t| match t {
            LocToken::Host(h) => Some(h.as_str()),
            LocToken::Entity(_) => None,
        })
        .collect::<HashSet<_>>()
    {
        reg.insert(token.to_string(), registrable_domain(token));
    }
    reg
}

/// Pass 2: channel-aware cosmetic selector subsumption.
///
/// Drops a plain-CSS cosmetic rule only when a *kept* rule provably covers it:
///
/// * **Identical selector, broader scope** — among rules with the same
///   selector and kind (`##` vs `#@#`), a rule whose positive location tokens
///   are covered by another's is redundant (the engine probes the hostname
///   label-chain, so a parent domain token matches its subdomains).
///   Negation-only scopes are opaque and never removable.
/// * **Bare-token selector cover** — a plain hide whose selector is exactly a
///   `.class`/`#id` token hides every element carrying that class/id (CSS
///   `display: none` cascades to the whole subtree). It therefore subsumes any
///   other plain hide whose target either carries that token itself or lives
///   inside an ancestor that carries it — `##.ad` covers `##div.ad`,
///   `##.ad.x`, `##.a .ad`, `##.ad > span`, `##div > span.ad`; `###main`
///   covers `##div#main`, `##.site #main`. Pseudo/attribute-led targets are
///   opaque (they carry no class/id token).
///
/// Safety invariants:
/// * Generic rules never cover host-scoped rules (`$generichide`).
/// * Exceptions (`#@#`) and procedural rules never participate as covers or
///   victims here (procedural rules are handled by [`subsume_procedural`]).
/// * Sibling combinators (`+`, `~`) end an ancestor chain: hiding a sibling
///   never hides the target.
///
/// Both directions are recomputed to a fixpoint, so a rule is only ever
/// removed when a survivor it is covered by also survives.
pub fn subsume_selectors(lines: &[String]) -> (Vec<String>, u64) {
    let mut rules: Vec<SelectorRule> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some((host, sep, selector)) = split_cosmetic(line) else {
            continue;
        };
        if is_procedural(selector) {
            continue;
        }
        let positives = if host.is_empty() {
            Some(Vec::new())
        } else {
            positive_location_tokens(host)
        };
        rules.push(SelectorRule {
            index,
            is_hide: sep == "##",
            selector,
            positives,
            bare: compute_bare_covers(selector),
        });
    }

    let reg = build_scope_registry(&rules);
    let mut removed: HashSet<usize> = HashSet::new();

    // Index rules by their selector so the fixpoint loop is near-linear. The
    // selector of a rule never changes, so the index is stable across
    // iterations; `removed` is filtered at use.
    let mut by_selector: HashMap<&str, Vec<usize>> = HashMap::new();
    for (idx, rule) in rules.iter().enumerate() {
        by_selector.entry(rule.selector).or_default().push(idx);
    }

    loop {
        let mut added = false;

        // (A) identical-selector, strictly-broader-scope cover.
        for rule in &rules {
            if removed.contains(&rule.index) {
                continue;
            }
            let Some(victim) = &rule.positives else {
                continue;
            };
            for &oi in by_selector.get(rule.selector).into_iter().flatten() {
                if removed.contains(&oi) || oi == rule.index {
                    continue;
                }
                let other = &rules[oi];
                if other.is_hide != rule.is_hide {
                    continue;
                }
                let Some(cover) = &other.positives else {
                    continue;
                };
                if scope_covers(cover, victim, &reg) && !scope_covers(victim, cover, &reg) {
                    removed.insert(rule.index);
                    added = true;
                    break;
                }
            }
        }

        // (B) bare-token selector cover, Indexed by token.
        let mut covers_by_token: HashMap<String, Vec<&SelectorRule>> = HashMap::new();
        for rule in &rules {
            if removed.contains(&rule.index) {
                continue;
            }
            if !rule.is_hide {
                continue;
            }
            for crypt in &rule.bare {
                covers_by_token.entry(crypt.clone()).or_default().push(rule);
            }
        }
        for victim in &rules {
            if removed.contains(&victim.index) || !victim.is_hide {
                continue;
            }
            let Some(vp) = &victim.positives else {
                continue;
            };
            for token in cover_candidates(victim.selector) {
                let Some(covers) = covers_by_token.get(&token) else {
                    continue;
                };
                if covers.iter().any(|c| {
                    c.index != victim.index
                        && c.positives
                            .as_ref()
                            .is_some_and(|cp| scope_covers(cp, vp, &reg))
                }) {
                    removed.insert(victim.index);
                    added = true;
                    break;
                }
            }
        }

        if !added {
            break;
        }
    }

    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !removed.contains(i))
        .map(|(_, l)| l.clone())
        .collect();
    (kept, removed.len() as u64)
}

/// Operators stripped to compute the plain-CSS base of a procedural selector.
/// `:upward`/`:xpath` are deliberately absent: they re-target the element the
/// rule applies to, so they can never be exchanged for a plain hide.
const BASE_STRIP_OPS: &[&str] = &[
    ":has-text(",
    ":matches-css(",
    ":matches-attr(",
    ":matches-path(",
    ":min-text-length(",
    ":style(",
    ":remove(",
    ":remove-attr(",
    ":remove-class(",
];

/// Plain-CSS base of a procedural selector: the selector with every executable
/// operator that *constrains* the target (text, CSS, attribute and path
/// matches, plus the actions) removed. Returns `None` when the base is empty
/// or still carries a procedural operator (`:upward`, `:xpath`, or any
/// survived operator of a nested argument) — such a rule cannot be exchanged
/// for a plain hide.
pub fn plain_base(selector: &str) -> Option<String> {
    let mut base = selector.to_string();
    for op in BASE_STRIP_OPS {
        loop {
            let Some(start) = base.find(op) else {
                break;
            };
            let arg_start = start + op.len();
            let arg_end = find_closing_paren(&base, arg_start)?;
            base.replace_range(start..arg_end + 1, "");
        }
    }
    let base = base.trim();
    if base.is_empty() || is_procedural(base) {
        return None;
    }
    Some(base.to_string())
}

/// Extract the sorted list of procedural operator names from a selector.
/// Each operator is the opening prefix (e.g., `:has-text(`, `:matches-css(`).
/// Used for constraint-count subsumption: fewer constraints = broader rule.
fn extract_constraint_ops(selector: &str) -> Vec<String> {
    let mut ops = Vec::new();
    for &op in EXECUTABLE_OPS {
        if selector.contains(op) {
            ops.push(op.to_string());
        }
    }
    ops.sort();
    ops
}

/// A cosmetic rule candidate for Pass-3 procedural subsumption.
struct ProceduralRule<'a> {
    index: usize,
    is_hide: bool,
    selector: &'a str,
    /// True when the selector still carries a procedural/action operator.
    procedural: bool,
    positives: Option<Vec<LocToken>>,
    /// Plain-CSS base for `##` hides that [`plain_base`] could compute.
    base: Option<String>,
    /// Sorted list of procedural operator names (e.g., `[":has-text(", ":matches-css("]`).
    /// Used for constraint-count subsumption: fewer constraints = broader rule.
    constraint_ops: Vec<String>,
}

/// Pass 3: procedural rule subsumption.
///
/// Three provable drops:
///
/// * **Plain hide over procedural variant** — a procedural hide whose plain-CSS
///   base (all constraining/action operators stripped) is exactly matched by a
///   plain hide at an equal-or-broader scope is redundant: the plain hide
///   already `display: none`s that element (and every element the procedural
///   rule would have selected), so the procedural rule adds nothing.
///   `##.ad` covers `##.ad:has-text(x)`. Rules using `:upward`/`:xpath` never
///   participate (they re-target the element).
/// * **Identical procedural selector, broader scope** — the engine stores
///   host-scoped procedural rules as JSON keyed by hostname token, which is
///   probed across the label chain; a narrower-scope duplicate is redundant.
/// * **Constraint-count subsumption** — a procedural rule with fewer constraints
///   (fewer procedural operators) is always at least as broad as one with more,
///   at the same base selector and equal-or-broader scope. `##.a:has-text(x)`
///   covers `##.a:has-text(x):matches-css(y)` because adding `:matches-css()`
///   only narrows the result set.
///
/// Exceptions (`#@#`) never participate in the plain-over-procedural direction
/// (the engine's exceptions are exact-selector-string prunes, so a `#@#.ad`
/// does not un-hide `.ad:has-text(x)`); identical-exception scope cover is
/// still applied. Generic rules are never covers (`$generichide`), and a
/// procedural rule is *never* dropped simply because an unanchored variant
/// exists — the unanchored rules are only reported by [`channel_counts`].
pub fn subsume_procedural(lines: &[String]) -> (Vec<String>, u64) {
    let mut rules: Vec<ProceduralRule> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some((host, sep, selector)) = split_cosmetic(line) else {
            continue;
        };
        let positives = if host.is_empty() {
            Some(Vec::new())
        } else {
            positive_location_tokens(host)
        };
        rules.push(ProceduralRule {
            index,
            is_hide: sep == "##",
            selector,
            procedural: is_procedural(selector),
            positives,
            base: if sep == "##" && is_procedural(selector) {
                plain_base(selector)
            } else {
                None
            },
            constraint_ops: if is_procedural(selector) {
                extract_constraint_ops(selector)
            } else {
                Vec::new()
            },
        });
    }

    let reg = build_scope_registry_procedural(&rules);
    let mut removed: HashSet<usize> = HashSet::new();

    // Indexes built once per fixpoint call; rules never mutate, `removed` is
    // filtered at use.
    let mut plain_by_selector: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_selector: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut by_base: HashMap<String, Vec<usize>> = HashMap::new();
    for (idx, rule) in rules.iter().enumerate() {
        by_selector.entry(rule.selector).or_default().push(idx);
        if rule.is_hide && !rule.procedural {
            plain_by_selector.entry(rule.selector).or_default().push(idx);
        }
        if let Some(base) = &rule.base {
            by_base.entry(base.clone()).or_default().push(idx);
        }
    }

    loop {
        let mut added = false;

        // (i) plain hide over procedural variant: with the same plain-CSS
        // base at an equal-or-broader scope, the plain hide already hides the
        // element (and every element the procedural rule would select).
        for victim in &rules {
            if removed.contains(&victim.index) || !victim.is_hide {
                continue;
            }
            let (Some(vp), Some(base)) = (&victim.positives, &victim.base) else {
                continue;
            };
            for &oi in plain_by_selector.get(base.as_str()).into_iter().flatten() {
                if removed.contains(&oi) || oi == victim.index {
                    continue;
                }
                let other = &rules[oi];
                if let Some(cp) = &other.positives {
                    if scope_covers(cp, vp, &reg) {
                        removed.insert(victim.index);
                        added = true;
                        break;
                    }
                }
            }
        }

        // (ii) identical procedural selector, broader scope (JSON is keyed by
        // hostname token, probed across the label chain).
        for victim in &rules {
            if removed.contains(&victim.index) {
                continue;
            }
            let Some(vp) = &victim.positives else {
                continue;
            };
            for &oi in by_selector.get(victim.selector).into_iter().flatten() {
                if removed.contains(&oi) || oi == victim.index {
                    continue;
                }
                let other = &rules[oi];
                if !other.procedural || !victim.procedural {
                    continue;
                }
                if other.is_hide != victim.is_hide {
                    continue;
                }
                let Some(cp) = &other.positives else {
                    continue;
                };
                if scope_covers(cp, vp, &reg) && !scope_covers(vp, cp, &reg) {
                    removed.insert(victim.index);
                    added = true;
                    break;
                }
            }
        }

        // (iii) constraint-count subsumption: a procedural rule with fewer
        // constraints is always at least as broad as one with more, at the same
        // base selector and equal-or-broader scope.
        for victim in &rules {
            if removed.contains(&victim.index) || !victim.procedural || !victim.is_hide {
                continue;
            }
            let Some(vp) = &victim.positives else {
                continue;
            };
            let Some(base) = &victim.base else {
                continue;
            };
            for &oi in by_base.get(base.as_str()).into_iter().flatten() {
                if removed.contains(&oi) || oi == victim.index {
                    continue;
                }
                let other = &rules[oi];
                if !other.procedural || !other.is_hide {
                    continue;
                }
                if other.is_hide != victim.is_hide {
                    continue;
                }
                // The cover must have a strict subset of the victim's
                // constraint operators (fewer constraints = broader).
                if other.constraint_ops.len() >= victim.constraint_ops.len() {
                    continue;
                }
                if !other
                    .constraint_ops
                    .iter()
                    .all(|op| victim.constraint_ops.contains(op))
                {
                    continue;
                }
                let Some(cp) = &other.positives else {
                    continue;
                };
                // Fewer constraints already proves strict breadth — only
                // verify the cover reaches the victim's URL set.
                if scope_covers(cp, vp, &reg) {
                    removed.insert(victim.index);
                    added = true;
                    break;
                }
            }
        }

        if !added {
            break;
        }
    }

    let kept: Vec<String> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !removed.contains(i))
        .map(|(_, l)| l.clone())
        .collect();
    (kept, removed.len() as u64)
}

/// Registrable-domain cache for the host tokens of procedural rules.
fn build_scope_registry_procedural(rules: &[ProceduralRule]) -> HashMap<String, Option<String>> {
    let mut reg: HashMap<String, Option<String>> = HashMap::new();
    for token in rules
        .iter()
        .flat_map(|r| r.positives.iter().flatten())
        .filter_map(|t| match t {
            LocToken::Host(h) => Some(h.as_str()),
            LocToken::Entity(_) => None,
        })
        .collect::<HashSet<_>>()
    {
        reg.insert(token.to_string(), registrable_domain(token));
    }
    reg
}

/// Registrable-domain registry for the host tokens of two isolated rules.
fn single_scope_registry(cover: &[LocToken], victim: &[LocToken]) -> HashMap<String, Option<String>> {
    let mut reg: HashMap<String, Option<String>> = HashMap::new();
    for token in cover.iter().chain(victim.iter()) {
        if let LocToken::Host(h) = token {
            reg.entry(h.clone()).or_insert_with(|| registrable_domain(h));
        }
    }
    reg
}

/// Public domination probe for the verifier: `true` when rule line `cover`
/// provably subsumes rule line `victim` under Pass 2 (`subsume_selectors`) and
/// Pass 3 (`subsume_procedural`). Returns `None` when either line is not a
/// cosmetic rule the passes consider (network rules, `#?#` extended syntax,
/// or an opaque scope).
///
/// Because the passes run to a fixpoint, a survivor of the final output that
/// has any surviving cover is a genuine pipeline bug: the passes would have
/// removed it, so the output is not in canonical form.
pub fn rule_subsumes(cover: &str, victim: &str) -> Option<bool> {
    let (ch, csep, csel) = split_cosmetic(cover)?;
    let (vh, vsep, vsel) = split_cosmetic(victim)?;
    let cpos = if ch.is_empty() {
        Some(Vec::new())
    } else {
        positive_location_tokens(ch)
    }?;
    let vpos = if vh.is_empty() {
        Some(Vec::new())
    } else {
        positive_location_tokens(vh)
    }?;
    let ckind = csep == "##";
    let vkind = vsep == "##";
    let cprocedural = is_procedural(csel);
    let vprocedural = is_procedural(vsel);

    let subsumed = if !vprocedural {
        if cprocedural {
            false
        } else {
            let reg = single_scope_registry(&cpos, &vpos);
            // Pass 2 (A): identical selector, same kind, strictly-broader scope.
            let identical_broader = ckind == vkind
                && csel == vsel
                && scope_covers(&cpos, &vpos, &reg)
                && !scope_covers(&vpos, &cpos, &reg);
            // Pass 2 (B): bare class/id hide over a descendant-class hide.
            let bare_cover = ckind
                && vkind
                && first_class_id_token(csel)
                    .is_some_and(|tok| tok == csel)
                && cover_candidates(vsel)
                    .iter()
                    .any(|tok| tok == first_class_id_token(csel).unwrap())
                && scope_covers(&cpos, &vpos, &reg);
            identical_broader || bare_cover
        }
    } else {
        let reg = single_scope_registry(&cpos, &vpos);
        // Pass 3 (i): a plain hide with the same plain-CSS base at an
        // equal-or-broader scope already hides the procedural target.
        let plain_over_procedural = vkind
            && ckind
            && !cprocedural
            && plain_base(vsel).is_some_and(|base| base == csel)
            && scope_covers(&cpos, &vpos, &reg);
        // Pass 3 (ii): identical procedural selector, same kind,
        // strictly-broader scope.
        let identical_procedural = cprocedural
            && ckind == vkind
            && csel == vsel
            && scope_covers(&cpos, &vpos, &reg)
            && !scope_covers(&vpos, &cpos, &reg);
        plain_over_procedural || identical_procedural
    };
    Some(subsumed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Transform with default options, returning just the produced lines.
    fn t(line: &str) -> Vec<String> {
        transform(line, &TransformOptions::default()).lines
    }

    /// Transform with pure-CSS comma splitting disabled.
    fn t_no_split(line: &str) -> Vec<String> {
        transform(
            line,
            &TransformOptions {
                split_comma_lists: false,
            },
        )
        .lines
    }

    #[test]
    fn passes_through_non_cosmetic_lines() {
        for line in [
            "||example.com^",
            "||example.com^$script",
            "! comment",
            "0.0.0.0 example.com",
        ] {
            assert_eq!(transform(line, &TransformOptions::default()).lines, vec![line.to_string()]);
        }
    }

    #[test]
    fn passes_through_single_piece_pure_css() {
        for line in [
            "example.com##.ad",
            "example.com##.a:has(> .b)",
            "example.com##a:not(.b)",
            "example.com##[href^=\"a,b\"]",
        ] {
            assert_eq!(transform(line, &TransformOptions::default()).lines, vec![line.to_string()]);
        }
    }

    #[test]
    fn splits_pure_css_comma_lists() {
        let out = transform("example.com##.a, .b, .c", &TransformOptions::default());
        assert!(out.comma_lists_split);
        assert_eq!(
            out.lines,
            vec![
                "example.com##.a".to_string(),
                "example.com##.b".to_string(),
                "example.com##.c".to_string(),
            ]
        );
        // Top-level commas inside attributes/negations are preserved.
        let out = transform("example.com##[href^=\"a,b\"], .c", &TransformOptions::default());
        assert!(out.comma_lists_split);
        assert_eq!(
            out.lines,
            vec![
                "example.com##[href^=\"a,b\"]".to_string(),
                "example.com##.c".to_string(),
            ]
        );
        // Exceptions split the same way (same first-token keying bug).
        let out = transform("example.com#@#.a, .b", &TransformOptions::default());
        assert!(out.comma_lists_split);
        assert_eq!(
            out.lines,
            vec![
                "example.com#@#.a".to_string(),
                "example.com#@#.b".to_string(),
            ]
        );
    }

    #[test]
    fn comma_splitting_can_be_disabled() {
        assert_eq!(t_no_split("example.com##.a, .b, .c"), vec!["example.com##.a, .b, .c".to_string()]);
    }

    #[test]
    fn strips_inert_min_text_length_zero() {
        assert_eq!(
            t("example.com##.a:min-text-length(0)"),
            vec!["example.com##.a".to_string()]
        );
        assert_eq!(
            t("example.com##.a:min-text-length(0):upward(1)"),
            vec!["example.com##.a:upward(1)".to_string()]
        );
        assert_eq!(
            t("example.com##.a:contains(x):min-text-length(0)"),
            vec!["example.com##.a:has-text(x)".to_string()]
        );
    }

    #[test]
    fn keeps_meaningful_min_text_length() {
        assert_eq!(
            t("example.com##.a:min-text-length(1)"),
            vec!["example.com##.a:min-text-length(1)".to_string()]
        );
    }

    #[test]
    fn classifies_generic_channels() {
        // Bare `.foo`/`#foo` -> cheapest channel.
        assert_eq!(classify_channel("##.foo"), Some(Channel::SimpleClassId));
        assert_eq!(classify_channel("###main"), Some(Channel::SimpleClassId));
        // Token-led compounds -> complex.
        assert_eq!(classify_channel("##.a.b"), Some(Channel::ComplexTokenLed));
        assert_eq!(classify_channel("##.a > div"), Some(Channel::ComplexTokenLed));
        assert_eq!(classify_channel("##.a, .b"), Some(Channel::ComplexTokenLed));
        assert_eq!(classify_channel("##.a:has(> .b)"), Some(Channel::ComplexTokenLed));
        // Non-token-led generic selectors are scanned on every page.
        assert_eq!(classify_channel("##div"), Some(Channel::GenericMisc));
        assert_eq!(classify_channel("##div.ad"), Some(Channel::GenericMisc));
        assert_eq!(classify_channel("##a[href^=\"x\"]"), Some(Channel::GenericMisc));
        assert_eq!(classify_channel("##[data-ad]"), Some(Channel::GenericMisc));
    }

    #[test]
    fn classifies_host_channels() {
        assert_eq!(classify_channel("example.com##.foo"), Some(Channel::HostnameHide));
        assert_eq!(classify_channel("example.com##div.ad"), Some(Channel::HostnameHide));
        assert_eq!(classify_channel("example.com##.a, .b"), Some(Channel::HostnameHide));
        assert_eq!(classify_channel("example.com#@#.ad"), Some(Channel::HostnameUnhide));
        // Procedural rules (surviving ones are always host-scoped).
        assert_eq!(
            classify_channel("example.com##.ad:has-text(x)"),
            Some(Channel::Procedural)
        );
        assert_eq!(
            classify_channel("example.com##.ad:style(display:none)"),
            Some(Channel::Procedural)
        );
    }

    #[test]
    fn classifies_negation_hosts_as_generic() {
        // `~host##.sel` is delivered to every page through the generic channel:
        // the engine's parser materializes the hidden generic rule alongside
        // the negated hostname entry.
        assert_eq!(classify_channel("~blocked.com##.foo"), Some(Channel::SimpleClassId));
        assert_eq!(classify_channel("~a.com,~b.com##div"), Some(Channel::GenericMisc));
    }

    #[test]
    fn classifies_non_cosmetic_lines_as_none() {
        for line in [
            "||example.com^",
            "! comment",
            "example.com#?#.a:-abp-properties(x)",
        ] {
            assert_eq!(classify_channel(line), None, "should skip {line}");
        }
    }

    #[test]
    fn channel_counts_aggregate() {
        let lines = [
            "##.a".to_string(),
            "##.b.c".to_string(),
            "##div".to_string(),
            "example.com##.x".to_string(),
            "example.com#@#.y".to_string(),
            "example.com##.z:has-text(w)".to_string(),
        ];
        let c = channel_counts(&lines);
        assert_eq!(c.simple_class_id, 1);
        assert_eq!(c.complex_token_led, 1);
        assert_eq!(c.generic_misc, 1);
        assert_eq!(c.hostname_hide, 1);
        assert_eq!(c.hostname_unhide, 1);
        assert_eq!(c.procedural, 1);
    }

    #[test]
    fn first_class_id_token_prefixes() {
        assert_eq!(first_class_id_token(".ad"), Some(".ad"));
        assert_eq!(first_class_id_token(".ad-banner_x"), Some(".ad-banner_x"));
        assert_eq!(first_class_id_token(".ad.banner"), Some(".ad"));
        assert_eq!(first_class_id_token("div.ad"), None);
        assert_eq!(first_class_id_token("[data-x]"), None);
        assert_eq!(first_class_id_token("#id"), Some("#id"));
        assert_eq!(first_class_id_token("#id.other"), Some("#id"));
    }

    #[test]
    fn rewrites_contains_to_has_text() {
        assert_eq!(
            t("example.com##.a:contains(CLICK HERE)"),
            vec!["example.com##.a:has-text(CLICK HERE)".to_string()]
        );
        assert_eq!(
            t("example.com##.a:contains(x):upward(1)"),
            vec!["example.com##.a:has-text(x):upward(1)".to_string()]
        );
    }

    #[test]
    fn rewrites_nth_ancestor_to_upward() {
        assert_eq!(
            t("example.com##.a:nth-ancestor(2)"),
            vec!["example.com##.a:upward(2)".to_string()]
        );
    }

    #[test]
    fn rewrites_abp_contains() {
        assert_eq!(
            t("example.com##.a:-abp-contains(x)"),
            vec!["example.com##.a:has-text(x)".to_string()]
        );
    }

    #[test]
    fn drops_dead_operators() {
        for line in [
            "example.com##.a:others()",
            "example.com##.a:others(.b)",
            "example.com##.a:matches-media((max-width: 1000px))",
            "example.com##.a:-abp-properties(content: \"x\")",
            "example.com##.a:matches-prop(height: 100px)",
            "example.com##.a:remove-attr()",
            "example.com##.a:has-text(x):others()",
        ] {
            assert_eq!(t(line), Vec::<String>::new(), "should drop {line}");
        }
    }

    #[test]
    fn strips_watch_attr_keeps_rest() {
        assert_eq!(
            t("example.com##.a:watch-attr(disabled):remove-class(is-locked)"),
            vec!["example.com##.a:remove-class(is-locked)".to_string()]
        );
        assert_eq!(
            t("example.com##.a:watch-attr(x)"),
            vec!["example.com##.a".to_string()]
        );
    }

    #[test]
    fn splits_procedural_comma_lists_individually() {
        assert_eq!(
            t("example.com##.a, .b:has-text(x)"),
            vec![
                "example.com##.a".to_string(),
                "example.com##.b:has-text(x)".to_string()
            ]
        );
        assert_eq!(
            t("example.com##.a:style(display:none), .b"),
            vec![
                "example.com##.a".to_string(),
                "example.com##.b".to_string()
            ]
        );
        // Split happens before rewrites, so pieces are rewritten individually.
        assert_eq!(
            t("example.com##.a:contains(x), .b:contains(y)"),
            vec![
                "example.com##.a:has-text(x)".to_string(),
                "example.com##.b:has-text(y)".to_string()
            ]
        );
        // A dropped piece is removed, the rest survive.
        assert_eq!(
            t("example.com##.a:others(), .b"),
            vec!["example.com##.b".to_string()]
        );
    }

    #[test]
    fn handles_exception_rules() {
        assert_eq!(
            t("example.com#@#.a:contains(x)"),
            vec!["example.com#@#.a:has-text(x)".to_string()]
        );
        assert_eq!(
            t("example.com#@#.a, .b:style(display:none)"),
            vec![
                "example.com#@#.a".to_string(),
                "example.com#@#.b".to_string()
            ]
        );
    }

    #[test]
    fn does_not_split_commas_inside_args() {
        assert_eq!(
            t("example.com##.a:style(background: url(a,b)), .c"),
            vec![
                "example.com##.a:style(background: url(a,b))".to_string(),
                "example.com##.c".to_string()
            ]
        );
    }

    #[test]
    fn leaves_abp_sharp_question_alone() {
        assert_eq!(
            t("example.com#?#.a:-abp-properties(x)"),
            vec!["example.com#?#.a:-abp-properties(x)".to_string()]
        );
    }

    #[test]
    fn drops_unbalanced_contains_args() {
        assert_eq!(
            t("example.com##.a:contains(foo(bar))"),
            Vec::<String>::new()
        );
    }

    #[test]
    fn split_top_level_respects_quotes_and_brackets() {
        assert_eq!(
            split_top_level("a[href^=\"x,y\"], .b:style(z: w)", ','),
            vec!["a[href^=\"x,y\"]".to_string(), ".b:style(z: w)".to_string()]
        );
    }

    #[test]
    fn subsume_generic_never_covers_host() {
        let lines = vec![
            "##.ad".to_string(),
            "example.com##.ad".to_string(),
            "www.example.com##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1); // www.example.com##.ad only (host-covered)
        assert_eq!(
            kept,
            vec![
                "##.ad".to_string(),
                "example.com##.ad".to_string(),
                "www.example.com##.ad".to_string()
            ]
            .into_iter()
            .filter(|l| l != "www.example.com##.ad")
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn subsume_parent_domain_covers_child() {
        let lines = vec![
            "example.com##.ad".to_string(),
            "www.example.com##.ad".to_string(),
            "sub.www.example.com##.ad".to_string(),
            "unrelated.com##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec![
                "example.com##.ad".to_string(),
                "unrelated.com##.ad".to_string()
            ]
        );
    }

    #[test]
    fn subsume_public_suffix_never_covers() {
        // A TLD/public-suffix token is below the registrable domain and is
        // never probed by the engine, so it cannot cover a real host.
        let lines = vec![
            "pl#@#[class$=\"-ads\"]".to_string(),
            "android.com.pl#@#[class$=\"-ads\"]".to_string(),
            "co.uk##.ad".to_string(),
            "www.bbc.co.uk##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn subsume_unrelated_hosts_kept() {
        let lines = vec![
            "a.com##.ad".to_string(),
            "b.com##.ad".to_string(),
            "a.com##.other".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn subsume_respects_kinds() {
        // A generic hide must not cover a #@# exception; parent exception
        // covers child exception of the same kind.
        let lines = vec![
            "##.ad".to_string(),
            "example.com#@#.ad".to_string(),
            "www.example.com#@#.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1);
        assert_eq!(
            kept,
            vec!["##.ad".to_string(), "example.com#@#.ad".to_string()]
        );
    }

    #[test]
    fn subsume_skips_opaque_rules() {
        // Unity-style `.*` entities *do* participate and cover subdomains, but
        // negations and procedural rules stay opaque.
        let lines = vec![
            "example.*##.ad".to_string(),
            "www.example.com##.ad".to_string(),
            "~blocked.com##.ad".to_string(),
            "a.com##.x:has-text(y)".to_string(),
            "www.a.com##.x:has-text(y)".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1);
        assert_eq!(
            kept,
            vec![
                "example.*##.ad".to_string(),
                "~blocked.com##.ad".to_string(),
                "a.com##.x:has-text(y)".to_string(),
                "www.a.com##.x:has-text(y)".to_string(),
            ]
        );
    }

    #[test]
    fn subsume_entity_covers_host_variants() {
        // `example.*` is probed by the engine for every label suffix of the
        // registrable domain plus the bare public suffix, so it covers the
        // classic domain, subdomains, and other TLDs — but NOT `otherexample.com`.
        let lines = vec![
            "example.*##.ad".to_string(),
            "example.com##.ad".to_string(),
            "www.example.com##.ad".to_string(),
            "example.org##.ad".to_string(),
            "otherexample.com##.ad".to_string(),
            "sub.example.co.uk##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 4);
        assert_eq!(
            kept,
            vec![
                "example.*##.ad".to_string(),
                "otherexample.com##.ad".to_string(),
            ]
        );
    }

    #[test]
    fn subsume_entity_over_entity() {
        let lines = vec![
            "example.*##.ad".to_string(),
            "sub.example.*##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1);
        assert_eq!(kept, vec!["example.*##.ad".to_string()]);
    }

    #[test]
    fn subsume_host_never_covers_entity() {
        // `example.*` is broader than `example.com`, so the hostname rule is
        // subsumed by the entity rule — never the other way around.
        let lines = vec![
            "example.com##.ad".to_string(),
            "example.*##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1);
        assert_eq!(kept, vec!["example.*##.ad".to_string()]);
    }

    #[test]
    fn subsume_negated_entity_is_opaque() {
        let lines = vec![
            "~example.*##.ad".to_string(),
            "example.com##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn entity_location_is_broader_than_hostname_in_engine() {
        // Ground truth from the engine's cosmetic probe logic: `example.*`
        // matches any registrable-domain label chain containing `example`,
        // while `example.com##.ad` is restricted to the `example.com` hostname.
        let engine = adblock::Engine::new_with_list_text("example.*##.ad\n".to_string());
        for host in [
            "example.com",
            "www.example.com",
            "example.co.uk",
            "deep.sub.example.org",
            "example.biz",
        ] {
            let res = engine.url_cosmetic_resources(&format!("https://{host}/"));
            assert!(
                res.hide_selectors.contains(".ad"),
                "entity example.* should hide .ad on {host}"
            );
        }
        let engine = adblock::Engine::new_with_list_text("example.com##.ad\n".to_string());
        assert!(engine
            .url_cosmetic_resources("https://www.example.com/")
            .hide_selectors
            .contains(".ad"));
        for host in ["example.org", "example.co.uk", "otherexample.com"] {
            let res = engine.url_cosmetic_resources(&format!("https://{host}/"));
            assert!(
                !res.hide_selectors.contains(".ad"),
                "hostname example.com##.ad must NOT hide .ad on {host}"
            );
        }
    }

    #[test]
    fn subsume_generic_rule_keeps_all_hosts() {
        let lines = vec![
            "##.ad".to_string(),
            "example.com##.ad".to_string(),
            "example.com#@#.ad".to_string(),
            "#@#.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn subsume_multi_token() {
        let lines = vec![
            "example.com,www.example.com##.ad".to_string(),
            "sub.example.com##.ad".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 1);
        assert_eq!(kept, vec!["example.com,www.example.com##.ad".to_string()]);
    }

    #[test]
    fn subsume_leaves_non_cosmetic_alone() {
        let lines = vec![
            "||example.com^".to_string(),
            "example.com#?#.x:-abp-properties(y)".to_string(),
            "! comment".to_string(),
        ];
        let (kept, removed) = subsume(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    // ---- Pass 2: subsume_selectors ----

    #[test]
    fn bare_token_covers_target_compounds() {
        for (cover, victims) in [
            ("##.ad", vec!["##div.ad", "##.ad.x", "##.a .ad", "##.ad > span", "##div > span.ad"]),
            ("###main", vec!["##div#main", "##.site #main", "##span#main.x"]),
        ] {
            for victim in victims {
                let lines = vec![cover.to_string(), victim.to_string()];
                let (kept, removed) = subsume_selectors(&lines);
                assert_eq!(removed, 1, "{cover} should cover {victim}");
                assert_eq!(kept, vec![cover.to_string()]);
            }
        }
    }

    #[test]
    fn sibling_combinator_ends_ancestor_chain() {
        // `.ad + .x` targets a sibling of the `.ad` element; hiding `.ad` does
        // not hide `.x`, so it must NOT be dropped.
        for victim in ["##.ad + .x", "##.ad ~ .x", "##a.ad + b"] {
            let lines = vec![
                "##.ad".to_string(),
                "example.com".to_string().replace("example.com", &victim),
            ];
            let (kept, removed) = subsume_selectors(&lines);
            assert_eq!(removed, 0, "{victim} must survive");
            assert_eq!(kept, lines);
        }
    }

    #[test]
    fn attr_and_pseudo_led_targets_are_opaque() {
        // No class/id token on the target => the bare `.ad` cannot prove cover.
        for victim in ["##[data-ad]", "##a[href^=\"ad\"]", "##a:not(.ad)", "##.ad:has(> span) + .x"] {
            let lines = vec!["##.ad".to_string(), victim.to_string()];
            let (kept, removed) = subsume_selectors(&lines);
            assert_eq!(removed, 0, "{victim} stays opaque to {lines:?}");
            assert_eq!(kept, lines);
        }
    }

    #[test]
    fn generic_never_covers_host_scoped() {
        let lines = vec![
            "##.ad".to_string(),
            "example.com##div.ad".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn host_scoped_bare_token_covers_host_victim() {
        let lines = vec![
            "example.*##.ad".to_string(),
            "example.com##div.ad".to_string(),
            "www.foo.example.com##.ad.x".to_string(),
            "unrelated.com##div.ad".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec![
                "example.*##.ad".to_string(),
                "unrelated.com##div.ad".to_string()
            ]
        );
    }

    #[test]
    fn exceptions_exempt_from_bare_token_cover() {
        let lines = vec![
            "##.ad".to_string(),
            "example.com#@#.ad.x".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn identical_selector_scope_cover_preserved() {
        let lines = vec![
            "example.com##.ad".to_string(),
            "www.example.com##.ad".to_string(),
            "example.com##.b.c".to_string(),
            "www.example.com##.b.c".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec![
                "example.com##.ad".to_string(),
                "example.com##.b.c".to_string()
            ]
        );
    }

    #[test]
    fn bare_cover_is_transitive_through_scope() {
        // `.ad` at the parent domain survives, so sub-subdomain victims are
        // still provably covered even when the intermediate `.ad` is itself
        // dropped (fixpoint).
        let lines = vec![
            "a.com##.ad".to_string(),
            "www.a.com##.ad".to_string(),
            "cdn.www.a.com##div.ad".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["a.com##.ad".to_string()]);
    }

    #[test]
    fn procedural_rules_opaque_to_pass2() {
        let lines = vec![
            "##.ad".to_string(),
            "example.com##.ad:has-text(x)".to_string(),
            "www.example.com##.ad:has-text(x)".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn negation_only_scopes_opaque() {
        let lines = vec![
            "example.com##.ad".to_string(),
            "~blocked.com##div.ad".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    // ---- Pass 2 tokenizer primitives ----

    #[test]
    fn split_compounds_respects_parens_and_attr() {
        let parts = split_compounds(".a:has(> .b) > .c").unwrap();
        let texts: Vec<&str> = parts.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(texts, vec![".a:has(> .b)", ".c"]);
        let parts = split_compounds("a[href^=\"x y\"] b").unwrap();
        assert_eq!(parts[0].1, "a[href^=\"x y\"]");
    }

    #[test]
    fn split_compounds_marks_sibling_combinators() {
        let parts = split_compounds(".a > .b + .c ~ .d").unwrap();
        assert_eq!(
            parts,
            vec![
                (Combinator::NoneOrDescendant, ".a".to_string()),
                (Combinator::Child, ".b".to_string()),
                (Combinator::Sibling, ".c".to_string()),
                (Combinator::Sibling, ".d".to_string()),
            ]
        );
    }

    #[test]
    fn compound_features_ignores_nested_classes() {
        let f = compound_features(".ad:has(> .x.b)");
        assert_eq!(f.classes, vec!["ad".to_string()]);
        assert!(f.has_pseudo);
        let f = compound_features("[data-x=\"a.b\"]");
        assert!(f.has_attr);
        assert!(f.classes.is_empty());
        let f = compound_features("div#main.ad");
        assert_eq!(f.ids, vec!["main".to_string()]);
        assert_eq!(f.classes, vec!["ad".to_string()]);
    }

    #[test]
    fn cover_candidates_derives_target_and_ancestor_tokens() {
        assert_eq!(cover_candidates("div.ad"), vec![".ad".to_string(), "div.ad".to_string()]);
        assert_eq!(cover_candidates(".a .ad"), vec![".a".to_string(), ".ad".to_string()]);
        assert_eq!(cover_candidates(".ad > span"), vec![".ad".to_string()]);
        assert_eq!(cover_candidates("div > span.ad"), vec![".ad".to_string(), "span.ad".to_string()]);
        // The sibling `.ad` is not an ancestor, so only the target token counts.
        assert_eq!(cover_candidates(".ad + .x"), vec![".x".to_string()]);
        assert_eq!(cover_candidates("[data-ad]"), Vec::<String>::new());
        assert_eq!(
            cover_candidates(".site #main"),
            vec!["#main".to_string(), ".site".to_string()]
        );
    }

    // ---- Pass 3: subsume_procedural ----

    #[test]
    fn plain_hide_covers_procedural_variant() {
        let lines = vec![
            "example.com##.ad".to_string(),
            "example.com##.ad:has-text(x)".to_string(),
            "example.com##.ad:min-text-length(0)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 2);
        assert_eq!(kept, vec!["example.com##.ad".to_string()]);
    }

    #[test]
    fn plain_hide_covers_procedural_across_scopes() {
        let lines = vec![
            "example.com##.ad".to_string(),
            "www.example.com##.ad:has-text(x)".to_string(),
            "unrelated.com##.ad:has-text(x)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 1);
        assert_eq!(
            kept,
            vec![
                "example.com##.ad".to_string(),
                "unrelated.com##.ad:has-text(x)".to_string()
            ]
        );
    }

    #[test]
    fn generic_plain_never_covers_procedural() {
        // A generic `.ad` is subject to `$generichide`; dropping the host-scoped
        // procedural rule would lose hiding on opted-out sites.
        let lines = vec![
            "##.ad".to_string(),
            "example.com##.ad:has-text(x)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn upward_procedural_never_exchanged_for_plain() {
        // `:upward(1)` re-targets the rule to an ancestor; plain `.ad` hides
        // the element itself, not its parent.
        let lines = vec![
            "example.com##.ad".to_string(),
            "example.com##.ad:upward(1)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn identical_procedural_scope_cover() {
        let lines = vec![
            "example.com##.widget:has-text(x)".to_string(),
            "www.example.com##.widget:has-text(x)".to_string(),
            "example.com#@#.widget:has-text(y)".to_string(),
            "www.example.com#@#.widget:has-text(y)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 2);
        assert_eq!(
            kept,
            vec![
                "example.com##.widget:has-text(x)".to_string(),
                "example.com#@#.widget:has-text(y)".to_string()
            ]
        );
    }

    #[test]
    fn exception_not_covered_by_unrelated_plain() {
        let lines = vec![
            "example.com#@#.ad".to_string(),
            "example.com#@#.ad:has-text(x)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        // The `#@#.ad` exact-string exception does not un-hide `.ad:has-text(x)`.
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    #[test]
    fn plain_base_strips_constraining_ops() {
        assert_eq!(plain_base(".ad:has-text(x)"), Some(".ad".to_string()));
        assert_eq!(
            plain_base(".ad:has-text(x):style(display: none)"),
            Some(".ad".to_string())
        );
        assert_eq!(
            plain_base(".ad:matches-css(width: 100px)"),
            Some(".ad".to_string())
        );
        assert_eq!(plain_base(".ad:upward(1)"), None);
        assert_eq!(plain_base(".ad:min-text-length(1)"), Some(".ad".to_string()));
        assert_eq!(plain_base(":has-text(x)"), None);
    }

    #[test]
    fn procedural_not_subsumed_without_plain_cover() {
        let lines = vec![
            "example.com##.ad:has-text(x)".to_string(),
            "example.com##.ad:has-text(y)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 0);
        assert_eq!(kept, lines);
    }

    // ---- Item 1: :style(display:none) rewrite ----

    #[test]
    fn style_display_none_stripped() {
        assert_eq!(
            t("example.com##.ad:style(display:none)"),
            vec!["example.com##.ad".to_string()]
        );
        assert_eq!(
            t("example.com##.ad:style(display: none)"),
            vec!["example.com##.ad".to_string()]
        );
        assert_eq!(
            t("example.com##.ad:style(display:none!important)"),
            vec!["example.com##.ad".to_string()]
        );
        assert_eq!(
            t("example.com##.ad:style(display: none !important)"),
            vec!["example.com##.ad".to_string()]
        );
        // Other style properties are kept.
        assert_eq!(
            t("example.com##.ad:style(color:red)"),
            vec!["example.com##.ad:style(color:red)".to_string()]
        );
        // Empty :style() is dropped (existing behavior).
        assert_eq!(t("example.com##.ad:style()"), Vec::<String>::new());
    }

    #[test]
    fn style_display_none_in_comma_list() {
        assert_eq!(
            t("example.com##.a:style(display:none), .b"),
            vec![
                "example.com##.a".to_string(),
                "example.com##.b".to_string()
            ]
        );
    }

    // ---- Items 2 & 5: Multi-class and compound bare covers ----

    #[test]
    fn multiclass_bare_cover() {
        let lines = vec![
            "example.com##.a.b".to_string(),
            "sub.example.com##div.a.b".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 1, "example.com##.a.b should cover sub.example.com##div.a.b");
        assert_eq!(kept, vec!["example.com##.a.b".to_string()]);
    }

    #[test]
    fn compound_bare_cover() {
        let lines = vec![
            "example.com##div.ad".to_string(),
            "sub.example.com##div.ad > .inner".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 1, "example.com##div.ad should cover sub.example.com##div.ad > .inner");
        assert_eq!(kept, vec!["example.com##div.ad".to_string()]);
    }

    #[test]
    fn multiclass_bare_cover_descendant() {
        let lines = vec![
            "example.com##.a.b".to_string(),
            "sub.example.com##.x .a.b".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 1, "example.com##.a.b should cover sub.example.com##.x .a.b");
        assert_eq!(kept, vec!["example.com##.a.b".to_string()]);
    }

    #[test]
    fn multiclass_bare_cover_does_not_cover_sibling() {
        let lines = vec![
            "example.com##.a.b".to_string(),
            "sub.example.com##.a.b + .x".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0, "##.a.b must not cover ##.a.b + .x");
        assert_eq!(kept, lines);
    }

    #[test]
    fn generic_never_covers_host_scoped_multiclass() {
        let lines = vec![
            "##.a.b".to_string(),
            "example.com##div.a.b".to_string(),
        ];
        let (kept, removed) = subsume_selectors(&lines);
        assert_eq!(removed, 0, "generic must not cover host-scoped");
        assert_eq!(kept, lines);
    }

    // ---- Item 4: Constraint-count subsumption ----

    #[test]
    fn constraint_count_subsumption() {
        let lines = vec![
            "example.com##.ad:has-text(x)".to_string(),
            "example.com##.ad:has-text(x):matches-css(display:block)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 1, "fewer constraints should cover more");
        assert_eq!(kept, vec!["example.com##.ad:has-text(x)".to_string()]);
    }

    #[test]
    fn constraint_count_subsumption_across_scopes() {
        let lines = vec![
            "example.com##.ad:has-text(x)".to_string(),
            "sub.example.com##.ad:has-text(x):matches-css(display:block)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 1);
        assert_eq!(kept, vec!["example.com##.ad:has-text(x)".to_string()]);
    }

    #[test]
    fn constraint_count_not_subsumed_when_same_ops() {
        let lines = vec![
            "example.com##.ad:has-text(x)".to_string(),
            "example.com##.ad:has-text(y)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 0, "same constraint count should not subsume");
        assert_eq!(kept, lines);
    }

    #[test]
    fn constraint_count_not_subsumed_when_narrower_scope() {
        let lines = vec![
            "sub.example.com##.ad:has-text(x)".to_string(),
            "example.com##.ad:has-text(x):matches-css(display:block)".to_string(),
        ];
        let (kept, removed) = subsume_procedural(&lines);
        assert_eq!(removed, 0, "narrower scope should not be subsumed");
        assert_eq!(kept, lines);
    }
}
