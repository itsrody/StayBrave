//! Post-normalization rewriting of cosmetic rules into forms the procedural
//! engine Brave ships actually executes.
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

/// Transform one cosmetic rule line, returning every rule it contributes.
/// Non-cosmetic lines pass through unchanged.
pub fn transform(line: &str) -> Vec<String> {
    let Some((host, sep, selector)) = split_cosmetic(line) else {
        return vec![line.to_string()];
    };
    if !is_procedural(selector) {
        return vec![line.to_string()];
    }
    split_top_level(selector, ',')
        .into_iter()
        .filter_map(|piece| transform_piece(&piece))
        .map(|selector| format!("{host}{sep}{selector}"))
        .collect()
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
fn is_procedural(selector: &str) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_through_non_cosmetic_lines() {
        for line in [
            "||example.com^",
            "||example.com^$script",
            "! comment",
            "0.0.0.0 example.com",
        ] {
            assert_eq!(transform(line), vec![line.to_string()]);
        }
    }

    #[test]
    fn passes_through_pure_css() {
        for line in [
            "example.com##.ad",
            "example.com##.a, .b, .c",
            "example.com##.a:has(> .b)",
            "example.com##a:not(.b)",
            "example.com##[href^=\"a,b\"]",
        ] {
            assert_eq!(transform(line), vec![line.to_string()]);
        }
    }

    #[test]
    fn rewrites_contains_to_has_text() {
        assert_eq!(
            transform("example.com##.a:contains(CLICK HERE)"),
            vec!["example.com##.a:has-text(CLICK HERE)".to_string()]
        );
        assert_eq!(
            transform("example.com##.a:contains(x):upward(1)"),
            vec!["example.com##.a:has-text(x):upward(1)".to_string()]
        );
    }

    #[test]
    fn rewrites_nth_ancestor_to_upward() {
        assert_eq!(
            transform("example.com##.a:nth-ancestor(2)"),
            vec!["example.com##.a:upward(2)".to_string()]
        );
    }

    #[test]
    fn rewrites_abp_contains() {
        assert_eq!(
            transform("example.com##.a:-abp-contains(x)"),
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
            assert_eq!(transform(line), Vec::<String>::new(), "should drop {line}");
        }
    }

    #[test]
    fn strips_watch_attr_keeps_rest() {
        assert_eq!(
            transform("example.com##.a:watch-attr(disabled):remove-class(is-locked)"),
            vec!["example.com##.a:remove-class(is-locked)".to_string()]
        );
        assert_eq!(
            transform("example.com##.a:watch-attr(x)"),
            vec!["example.com##.a".to_string()]
        );
    }

    #[test]
    fn splits_commas_only_when_procedural() {
        assert_eq!(
            transform("example.com##.a, .b:has-text(x)"),
            vec![
                "example.com##.a".to_string(),
                "example.com##.b:has-text(x)".to_string()
            ]
        );
        assert_eq!(
            transform("example.com##.a:style(display:none), .b"),
            vec![
                "example.com##.a:style(display:none)".to_string(),
                "example.com##.b".to_string()
            ]
        );
        // Split happens before rewrites, so pieces are rewritten individually.
        assert_eq!(
            transform("example.com##.a:contains(x), .b:contains(y)"),
            vec![
                "example.com##.a:has-text(x)".to_string(),
                "example.com##.b:has-text(y)".to_string()
            ]
        );
        // A dropped piece is removed, the rest survive.
        assert_eq!(
            transform("example.com##.a:others(), .b"),
            vec!["example.com##.b".to_string()]
        );
    }

    #[test]
    fn handles_exception_rules() {
        assert_eq!(
            transform("example.com#@#.a:contains(x)"),
            vec!["example.com#@#.a:has-text(x)".to_string()]
        );
        assert_eq!(
            transform("example.com#@#.a, .b:style(display:none)"),
            vec![
                "example.com#@#.a".to_string(),
                "example.com#@#.b:style(display:none)".to_string()
            ]
        );
    }

    #[test]
    fn does_not_split_commas_inside_args() {
        assert_eq!(
            transform("example.com##.a:style(background: url(a,b)), .c"),
            vec![
                "example.com##.a:style(background: url(a,b))".to_string(),
                "example.com##.c".to_string()
            ]
        );
    }

    #[test]
    fn leaves_abp_sharp_question_alone() {
        assert_eq!(
            transform("example.com#?#.a:-abp-properties(x)"),
            vec!["example.com#?#.a:-abp-properties(x)".to_string()]
        );
    }

    #[test]
    fn drops_unbalanced_contains_args() {
        assert_eq!(
            transform("example.com##.a:contains(foo(bar))"),
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
}
