use crate::config::FilterConfig;
use adblock::filters::cosmetic::{CosmeticFilter, CosmeticFilterMask, CosmeticFilterOperator};
use adblock::filters::network::{NetworkFilter, NetworkFilterFeaturesMask};
use std::collections::HashSet;

/// Drops rules that reference functionality the Brave engine cannot execute.
pub struct Filterer {
    pub scriptlets: bool,
    redirect_allowlist: HashSet<String>,
}

impl Filterer {
    pub fn new(cfg: &FilterConfig) -> Self {
        Self {
            scriptlets: cfg.scriptlets,
            redirect_allowlist: cfg.redirect_allowlist.iter().cloned().collect(),
        }
    }

    /// True for uBO scriptlet-injection cosmetic rules (`##+js(...)`,
    /// `#@#+js(...)`) and legacy `##script:inject(...)`. The engine parses them
    /// as cosmetic filters but has no scriptlet runtime to execute them.
    pub fn is_scriptlet(&self, f: &CosmeticFilter) -> bool {
        if !self.scriptlets {
            return false;
        }
        if f.mask.contains(CosmeticFilterMask::SCRIPT_INJECT) {
            return true;
        }
        f.selector.iter().any(
            |op| matches!(op, CosmeticFilterOperator::CssSelector(s) if s.contains("script:inject(")),
        )
    }

    /// True for `$redirect`/`$redirect-rule` rules whose resource is not in the
    /// supported set. Such rules can never resolve to an actual redirect, so
    /// they are dead weight.
    pub fn is_unsupported_redirect(&self, f: &NetworkFilter) -> bool {
        if !f.features_mask.contains(NetworkFilterFeaturesMask::IS_REDIRECT) {
            return false;
        }
        match f.modifier_option {
            Some(resource) => !self.redirect_allowlist.contains(resource),
            None => true,
        }
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

    fn filterer() -> Filterer {
        Filterer::new(&FilterConfig::default())
    }

    #[test]
    fn strips_scriptlet_injection() {
        let f = filterer();
        for line in [
            "example.com##+js(set-constant, foo, bar)",
            "example.com#@#+js(abort-on-property-read, foo)",
            "example.com##script:inject(abort-on-property-read.js)",
        ] {
            let ParsedLine::Cosmetic(cf) = parse(line) else {
                panic!("{line} not cosmetic");
            };
            assert!(f.is_scriptlet(&cf), "should flag {line}");
        }
    }

    #[test]
    fn keeps_plain_cosmetic() {
        let f = filterer();
        for line in ["example.com##.ad", "example.com##.ad > p", "example.com#@#.ad"] {
            let ParsedLine::Cosmetic(cf) = parse(line) else {
                panic!("{line} not cosmetic");
            };
            assert!(!f.is_scriptlet(&cf), "should keep {line}");
        }
    }

    #[test]
    fn scriptlets_can_be_disabled() {
        let cfg = FilterConfig {
            scriptlets: false,
            redirect_allowlist: Vec::new(),
        };
        let f = Filterer::new(&cfg);
        let ParsedLine::Cosmetic(cf) = parse("example.com##+js(set-constant, foo)") else {
            panic!("not cosmetic");
        };
        assert!(!f.is_scriptlet(&cf));
    }

    #[test]
    fn redirect_allowlist() {
        let f = filterer();
        for line in [
            "||example.com^$redirect=noop.js",
            "||example.com^$redirect=noopjs",
            "||example.com^$redirect-rule=1x1.gif",
            "||example.com^$redirect=googlesyndication_adsbygoogle.js",
        ] {
            let ParsedLine::Network(nf) = parse(line) else {
                panic!("{line} not network");
            };
            assert!(!f.is_unsupported_redirect(&nf), "should allow {line}");
        }
        for line in [
            "||example.com^$redirect=does-not-exist.resource",
            "||example.com^$redirect=chartbeat.js",
            "||example.com^$redirect-rule=noop-not-real.js",
        ] {
            let ParsedLine::Network(nf) = parse(line) else {
                panic!("{line} not network");
            };
            assert!(f.is_unsupported_redirect(&nf), "should drop {line}");
        }
    }

    #[test]
    fn non_redirect_modifiers_kept() {
        let f = filterer();
        for line in [
            "||example.com^$csp=script-src 'none'",
            "||example.com^$removeparam=x",
            "||example.com^$script",
        ] {
            let ParsedLine::Network(nf) = parse(line) else {
                panic!("{line} not network");
            };
            assert!(!f.is_unsupported_redirect(&nf), "should keep {line}");
        }
    }
}
