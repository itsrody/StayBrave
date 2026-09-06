use adblock::Engine;
use staybrave::cosmetic;
use staybrave::network;
use staybrave::rewriter::Rewriter;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::time::Instant;

/// Parse a cosmetic rule line into `(host, separator, selector)`, mirroring the
/// optimizer's `split_cosmetic` (excludes `#?#` extended syntax).
fn part_cosmetic(line: &str) -> Option<(&str, &str, &str)> {
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

/// Selector-keyed index of a cosmetic rule set, for finding the provable cover
/// of a rule removed by Pass 2/3.
struct CosIndex<'a> {
    /// Selector string -> full rule lines. Also the victim pool: a removed
    /// selector must have had a real line (an engine probe discovered it).
    by_selector_legacy: HashMap<&'a str, Vec<&'a str>>,
    by_selector_pass23: HashMap<&'a str, Vec<&'a str>>,
    /// Bare `.class`/`#id` selector lines (Pass 2B covers) in the Pass-2/3 set.
    bare_by_token: HashMap<String, Vec<&'a str>>,
}

impl<'a> CosIndex<'a> {
    fn build(legacy: &'a [String], pass23: &'a [String]) -> CosIndex<'a> {
        let mut index = CosIndex {
            by_selector_legacy: HashMap::new(),
            by_selector_pass23: HashMap::new(),
            bare_by_token: HashMap::new(),
        };
        for line in legacy {
            if let Some((_, _, sel)) = part_cosmetic(line) {
                index.by_selector_legacy.entry(sel).or_default().push(line);
            }
        }
        for line in pass23 {
            let Some((_, sep, sel)) = part_cosmetic(line) else {
                continue;
            };
            index.by_selector_pass23.entry(sel).or_default().push(line);
            if sep == "##" && cosmetic::first_class_id_token(sel).is_some_and(|t| t == sel) {
                index.bare_by_token.entry(sel.to_string()).or_default().push(line);
            }
        }
        index
    }

    /// True when a rule with `selector` exists in the legacy set whose removal
    /// the Pass-2/3 set provably covers: some surviving cover line subsumes
    /// some legacy victim line via `cosmetic::rule_subsumes` (identical-selector
    /// broader-scope, bare-token, or plain-over-procedural).
    fn provably_covered(&self, selector: &str) -> bool {
        let Some(victims) = self.by_selector_legacy.get(selector) else {
            return true; // nothing was removed with this selector
        };
        let mut covers: Vec<&str> = self
            .by_selector_pass23
            .get(selector)
            .cloned()
            .unwrap_or_default();
        if let Some(base) = cosmetic::plain_base(selector) {
            if let Some(g) = self.by_selector_pass23.get(base.as_str()) {
                covers.extend(g.iter().copied());
            }
        }
        for tok in cosmetic::cover_candidates(selector) {
            if let Some(g) = self.bare_by_token.get(&tok) {
                covers.extend(g.iter().copied());
            }
        }
        covers.sort_unstable();
        covers.dedup();
        covers.iter().any(|c| {
            victims
                .iter()
                .any(|v| *c != *v && cosmetic::rule_subsumes(c, v) == Some(true))
        })
    }
}

fn cosmetic_sep(line: &str) -> Option<(usize, &'static str)> {
    ["#@#", "##", "#?#"]
        .iter()
        .find_map(|sep| line.find(sep).map(|i| (i, *sep)))
}

fn is_cosmetic(line: &str) -> bool {
    cosmetic_sep(line).is_some()
}

/// All simple `.class` / `#id` tokens appearing anywhere in the cosmetic
/// selectors. Only used for a single generic-path sanity check: the
/// `hidden_class_id_selectors` path reads exclusively generic rules
/// (`simple_class_rules`/`complex_class_rules`), which subsumption never
/// removes, so its output is provably unaffected.
fn extract_class_id_tokens(lines: &[String]) -> (HashSet<String>, HashSet<String>) {
    let mut classes = HashSet::new();
    let mut ids = HashSet::new();
    for line in lines {
        let Some((idx, sep)) = cosmetic_sep(line) else {
            continue;
        };
        if sep == "#?#" {
            continue;
        }
        let selector = &line[idx + sep.len()..];
        let bytes = selector.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let c = bytes[i];
            let boundary = i == 0
                || !(bytes[i - 1].is_ascii_alphanumeric()
                    || bytes[i - 1] == b'_'
                    || (bytes[i - 1] == b'-' && c != b'.' && c != b'#'));
            if (c == b'.' || c == b'#') && boundary {
                let mut j = i + 1;
                while j < bytes.len()
                    && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-' || bytes[j] == b'_')
                {
                    j += 1;
                }
                let token = selector[i + 1..j].to_string();
                if !token.is_empty() {
                    if c == b'.' {
                        classes.insert(token);
                    } else {
                        ids.insert(token);
                    }
                }
                i = j;
                continue;
            }
            i += 1;
        }
    }
    (classes, ids)
}

fn sample_hosts(lines: &[String]) -> Vec<String> {
    let mut hosts = HashSet::new();
    let fixed = [
        "example.com",
        "example.org",
        "www.google.com",
        "www.youtube.com",
        "m.facebook.com",
        "reddit.com",
        "www.reddit.com",
        "amazon.com",
        "www.amazon.com",
        "x.com",
        "github.com",
        "docs.rs",
        "developer.mozilla.org",
        "mail.google.com",
        "news.ycombinator.com",
        "stackoverflow.com",
        "www.netflix.com",
        "store.steampowered.com",
        "play.google.com",
        "apis.google.com",
        "google.com",
        "youtube.com",
        "facebook.com",
    ];
    hosts.extend(fixed.iter().map(|h| h.to_string()));
    for line in lines {
        if let Some((idx, sep)) = cosmetic_sep(line) {
            if sep == "#?#" {
                continue;
            }
            let host = &line[..idx];
            let host = host.trim();
            if host.is_empty() {
                continue;
            }
            if host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
            {
                hosts.insert(host.to_string());
            }
        }
    }
    let mut out = Vec::new();
    for host in hosts {
        out.push(host.clone());
        out.push(format!("www.{host}"));
        out.push(format!("deep.sub.{host}"));
    }
    out.sort();
    out.dedup();
    let cap: usize = std::env::var("EQ_MAX_HOSTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20_000);
    out.truncate(cap);
    out
}

fn compare_resources(
    a: &adblock::cosmetic_filter_cache::UrlSpecificResources,
    b: &adblock::cosmetic_filter_cache::UrlSpecificResources,
) -> bool {
    a.hide_selectors == b.hide_selectors
        && a.procedural_actions == b.procedural_actions
        && a.exceptions == b.exceptions
        && a.injected_script == b.injected_script
        && a.generichide == b.generichide
}

/// Compare the observable network outcome of a request across two engines.
fn compare_network(
    a: &adblock::blocker::BlockerResult,
    b: &adblock::blocker::BlockerResult,
) -> bool {
    a.should_block() == b.should_block()
        && a.exception.is_some() == b.exception.is_some()
        && a.redirect == b.redirect
        && a.rewritten_url == b.rewritten_url
}

/// Adversarial probe URLs for a simple rule, exercising the host-suffix and
/// path-prefix boundaries where a too-aggressive subsume would break.
fn probe_urls(raw: &str) -> Vec<String> {
    let Some(r) = network::parse_simple_rule(raw) else {
        return Vec::new();
    };
    let base = if r.path.is_empty() {
        format!("https://{}/", r.host)
    } else {
        format!("https://{}/{}", r.host, r.path)
    };
    let mut urls = vec![
        base.clone(),
        format!("{base}/extra"),
        format!("{base}?q=1"),
        format!("https://{}/", r.host),
        format!("https://www.{}/", r.host),
        format!("https://deep.sub.{}/", r.host),
    ];
    if !r.path.is_empty() {
        urls.push(format!("https://{}/", r.host));
        urls.push(format!("https://www.{}/{}", r.host, r.path));
        // Same-boundary-differing path: the cover's `^` separator must not
        // swallow a longer literal.
        urls.push(format!("https://{}/{}x", r.host, r.path));
    }
    urls.sort();
    urls.dedup();
    urls
}

/// Request types each corpus URL is probed across. The navigation types
/// (`document`, `sub_frame`) matter most: `||host^` blocks them but a narrower
/// rewrite (`||host/`) silently would not, and probing only `other` cannot see
/// the difference.
const REQUEST_TYPES: &[&str] = &["other", "script", "sub_frame", "document"];

fn check_corpus(before: &Engine, after: &Engine, urls: &[String]) -> (usize, usize) {
    let mut mismatches = 0usize;
    let mut checked = 0usize;
    for url in urls {
        for rtype in REQUEST_TYPES {
            if let Ok(req) =
                adblock::request::Request::new(url, "https://www.example.com/", rtype, "GET")
            {
                let ra = before.check_network_request(&req);
                let rb = after.check_network_request(&req);
                if !compare_network(&ra, &rb) {
                    mismatches += 1;
                    if mismatches <= 10 {
                        eprintln!(
                            "NET MISMATCH {rtype} {url}: before(block={},exc={},redir={:?}) after(block={},exc={},redir={:?})",
                            ra.should_block(),
                            ra.exception.is_some(),
                            ra.redirect,
                            rb.should_block(),
                            rb.exception.is_some(),
                            rb.redirect,
                        );
                    }
                }
            }
            checked += 1;
        }
    }
    (checked, mismatches)
}

fn main() -> anyhow::Result<()> {
    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "StayBrave-Classic.txt".into());

    let t0 = Instant::now();
    let mut lines: Vec<String> = std::fs::read_to_string(&out_path)?
        .lines()
        .map(|l| l.to_string())
        .collect();
    lines.sort();
    lines.dedup();
    println!(
        "[{:4}ms] read {} unique lines",
        t0.elapsed().as_millis(),
        lines.len()
    );
    std::io::stdout().flush().unwrap();

    let cosmetic_lines: Vec<String> = lines.iter().filter(|l| is_cosmetic(l)).cloned().collect();

    // ---- Stage 1: cosmetic cost passes (Pass 2 + 3) equivalence -------------
    // The legacy pass (same-selector scope subsumption) is compared against the
    // actual optimizer pipeline (Pass 2 `subsume_selectors` + Pass 3
    // `subsume_procedural`). Pass 2/3 removes rules that are provably covered
    // by a *different* rule string (bare `.ad` over `div.ad`, a plain hide over
    // a `:has-text` variant), so per-engine rule output is not byte-identical:
    // the harness requires engine-level behaviour equality — every selector the
    // legacy engine would deliver/hide that the optimizer drops must have a
    // surviving cover, and nothing new may appear.
    let t = Instant::now();
    let legacy_kept: HashSet<String> = cosmetic::subsume(&cosmetic_lines).0.into_iter().collect();
    let t_legacy = t.elapsed().as_millis();
    let t = Instant::now();
    let pass2 = cosmetic::subsume_selectors(&cosmetic_lines).0;
    let t_pass2 = t.elapsed().as_millis();
    let pass23: HashSet<String> = cosmetic::subsume_procedural(&pass2).0.into_iter().collect();
    let legacy_removed = cosmetic_lines.len() - legacy_kept.len();
    let pass23_removed = cosmetic_lines.len() - pass23.len();
    println!(
        "[{:4}ms] cosmetic passes: legacy subsume removed {legacy_removed} in {t_legacy}ms; Pass 2 removed {} in {t_pass2}ms, Pass 3 removed {} total",
        t.elapsed().as_millis(),
        pass23_removed - legacy_removed,
        pass23_removed
    );
    std::io::stdout().flush().unwrap();

    let after_legacy: Vec<String> = lines
        .iter()
        .filter(|l| !is_cosmetic(l) || legacy_kept.contains(*l))
        .cloned()
        .collect();
    let after_pass23: Vec<String> = lines
        .iter()
        .filter(|l| !is_cosmetic(l) || pass23.contains(*l))
        .cloned()
        .collect();
    let index = CosIndex::build(&after_legacy, &after_pass23);

    let t = Instant::now();
    let before = Engine::new_with_list_text(after_legacy.join("\n"));
    println!("[{:4}ms] built before engine (legacy cosmetic pass)", t.elapsed().as_millis());
    let t = Instant::now();
    let after = Engine::new_with_list_text(after_pass23.join("\n"));
    println!(
        "[{:4}ms] built after engine (Pass 2+3)",
        t.elapsed().as_millis()
    );
    std::io::stdout().flush().unwrap();

    let (classes, ids) = extract_class_id_tokens(&cosmetic_lines);
    println!(
        "global token set: {} classes, {} ids",
        classes.len(),
        ids.len()
    );
    std::io::stdout().flush().unwrap();

    let hosts = sample_hosts(&cosmetic_lines);
    println!("probing {} hostnames", hosts.len());
    std::io::stdout().flush().unwrap();

    // Host-scoped evaluation: UrlSpecificResources per host.
    let t = Instant::now();
    let mut mismatches = 0usize;
    let mut checked = 0usize;
    let host_cap: usize = std::env::var("EQ_COSMETIC_HOSTS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);
    for host in hosts.iter().take(host_cap) {
        let url = format!("https://{host}/");
        let ra = before.url_cosmetic_resources(&url);
        let rb = after.url_cosmetic_resources(&url);
        checked += 1;
        // Exceptions, generichide and injected scripts must be identical: Pass
        // 2/3 never adds one, and identical-selector removals are delivered
        // through the surviving broader scope anyway.
        if ra.exceptions != rb.exceptions
            || ra.generichide != rb.generichide
            || ra.injected_script != rb.injected_script
        {
            mismatches += 1;
            eprintln!(
                "COS MISMATCH {host}: exceptions only-before={:?} only-after={:?}, generichide {}/{}",
                ra.exceptions.difference(&rb.exceptions).take(4).collect::<Vec<_>>(),
                rb.exceptions.difference(&ra.exceptions).take(4).collect::<Vec<_>>(),
                ra.generichide,
                rb.generichide
            );
            continue;
        }
        // Hides and procedural actions may only shrink; every dropped selector
        // must be provably covered by a surviving rule.
        let ra_hides: HashSet<&String> = ra.hide_selectors.iter().collect();
        let rb_hides: HashSet<&String> = rb.hide_selectors.iter().collect();
        let ra_proc: HashSet<&String> = ra.procedural_actions.iter().collect();
        let rb_proc: HashSet<&String> = rb.procedural_actions.iter().collect();
        if !rb_hides.is_subset(&ra_hides) || !rb_proc.is_subset(&ra_proc) {
            mismatches += 1;
            eprintln!("COS MISMATCH {host}: new hide/procedural selector appeared");
            continue;
        }
        for s in ra_hides.difference(&rb_hides) {
            if !index.provably_covered(s) {
                mismatches += 1;
                if mismatches <= 10 {
                    eprintln!("COS MISMATCH {host}: dropped hide {s} has no surviving cover");
                }
            }
        }
        for s in ra_proc.difference(&rb_proc) {
            if !index.provably_covered(s) {
                mismatches += 1;
                if mismatches <= 10 {
                    eprintln!("COS MISMATCH {host}: dropped procedural action {s} has no surviving cover");
                }
            }
        }
    }
    println!(
        "[{:4}ms] compared {} url_cosmetic_resources checks: {mismatches} mismatches",
        t.elapsed().as_millis(),
        checked
    );
    std::io::stdout().flush().unwrap();

    // Generic path evaluation: hidden_class_id_selectors across page scenarios.
    // Pass 2B/3i only remove *generic-covered* victims here; the cover selector
    // must be hidden on any page where the victim's token is present, so page
    // scenarios with real tokens materialize the widening and the diff-acceptance
    // catches any removal whose cover does not survive.
    let t = Instant::now();
    let classes_pool: Vec<String> = classes.iter().take(2_000).cloned().collect();
    let ids_pool: Vec<String> = ids.iter().take(500).cloned().collect();
    let mut checked_generic = 0usize;
    let mut mismatches_generic = 0usize;
    for host in hosts.iter().take(host_cap) {
        let url = format!("https://{host}/");
        for (c, i) in [
            (Vec::new(), Vec::new()),
            (
                classes_pool.iter().take(25).cloned().collect(),
                ids_pool.iter().take(10).cloned().collect(),
            ),
        ] {
            let ha_vec = before.hidden_class_id_selectors(&c, &i, &HashSet::new());
            let hb_vec = after.hidden_class_id_selectors(&c, &i, &HashSet::new());
            let ha: HashSet<&String> = ha_vec.iter().collect();
            let hb: HashSet<&String> = hb_vec.iter().collect();
            checked_generic += 1;
            if !hb.is_subset(&ha) {
                mismatches_generic += 1;
                eprintln!("COS MISMATCH {url}: new generic hidden selector appeared");
                continue;
            }
            for s in ha.difference(&hb) {
                if !index.provably_covered(s) {
                    mismatches_generic += 1;
                    if mismatches_generic <= 10 {
                        eprintln!("COS MISMATCH {url}: dropped generic hidden {s} has no surviving cover");
                    }
                }
            }
        }
    }
    println!(
        "[{:4}ms] compared {} hidden_class_id_selectors page checks: {mismatches_generic} mismatches",
        t.elapsed().as_millis(),
        checked_generic
    );
    std::io::stdout().flush().unwrap();
    mismatches += mismatches_generic;

    // ---- Stage 2: network optimization equivalence ------------------------
    let t = Instant::now();
    let report = Rewriter::default().rewrite_list(after_pass23.clone());
    let pre_subsumed: HashSet<String> = report.rules.iter().cloned().collect();
    let (network_lines, network_subsumed) = network::subsume(&report.rules);
    let kept_network: HashSet<String> = network_lines.iter().cloned().collect();
    println!(
        "[{:4}ms] network passes: {} rewritten, {} semantic duplicates merged, {} subsumed ({} -> {} lines)",
        t.elapsed().as_millis(),
        report.stats.rewritten,
        report.stats.merged_duplicates,
        network_subsumed,
        after_pass23.len(),
        network_lines.len()
    );
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let net_after = Engine::new_with_list_text(network_lines.join("\n"));
    println!("[{:4}ms] built network-after engine", t.elapsed().as_millis());
    std::io::stdout().flush().unwrap();

    // Corpus: every subsumed rule (the danger zone) probed adversarially, plus
    // every rewritten/merged-away rule, plus the fixed host sample.
    let mut corpus: HashSet<String> = HashSet::new();
    for line in &report.rules {
        if !kept_network.contains(line) {
            corpus.extend(probe_urls(line));
        }
    }
    let rewritten: HashSet<String> = after_pass23
        .iter()
        .filter(|l| !pre_subsumed.contains(*l))
        .cloned()
        .collect();
    for line in &rewritten {
        corpus.extend(probe_urls(line));
    }
    // In steady state the rewritten list is already minimal and the danger zone
    // above is empty, so also sample broadly across ALL network rules — this
    // keeps the request-type matrix (document/sub_frame included) exercised on
    // every run rather than going silent when nothing was removed.
    let step = (report.rules.len() / 60_000).max(1);
    for line in report.rules.iter().step_by(step) {
        corpus.extend(probe_urls(line));
    }
    let cap: usize = std::env::var("EQ_MAX_NET_URLS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600_000);
    let mut corpus: Vec<String> = corpus.into_iter().collect();
    corpus.sort();
    if corpus.len() > cap {
        corpus.truncate(cap);
    }
    println!("network corpus: {} probe URLs", corpus.len());
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let (checked_net, mismatches_net) = check_corpus(&after, &net_after, &corpus);
    println!(
        "[{:4}ms] compared {} network checks: {mismatches_net} mismatches",
        t.elapsed().as_millis(),
        checked_net
    );
    std::io::stdout().flush().unwrap();

    // Cosmetic parity must also survive the network passes (the rewriter
    // merges semantically-equivalent cosmetic rules).
    let t = Instant::now();
    let mut mismatches_cos = 0usize;
    for host in hosts.iter().take(2_000) {
        let url = format!("https://{host}/");
        let ra = after.url_cosmetic_resources(&url);
        let rb = net_after.url_cosmetic_resources(&url);
        if !compare_resources(&ra, &rb) {
            mismatches_cos += 1;
        }
    }
    println!(
        "[{:4}ms] cosmetic parity across network passes: {mismatches_cos} mismatches of {}",
        t.elapsed().as_millis(),
        hosts.len().min(2_000)
    );
    std::io::stdout().flush().unwrap();

    // ---- Serialization size (proxy for engine memory) ----------------------
    let t = Instant::now();
    let a_ser = before.serialize();
    let t_ser_a = t.elapsed().as_millis();
    let t = Instant::now();
    let b_ser = net_after.serialize();
    let t_ser_b = t.elapsed().as_millis();
    let b_ser2 = net_after.serialize();
    let deterministic = b_ser == b_ser2;
    println!(
        "serialize: before {:.2} MB in {t_ser_a}ms, after {:.2} MB in {t_ser_b}ms (deterministic: {deterministic})",
        a_ser.len() as f64 / 1e6,
        b_ser.len() as f64 / 1e6
    );
    std::io::stdout().flush().unwrap();

    println!(
        "summary: -{pass23_removed} cosmetic rules (Pass 2+3), -{network_subsumed} network rules, -{} merged; {} before -> {} after lines",
        report.stats.merged_duplicates,
        lines.len(),
        network_lines.len()
    );

    let ok = mismatches == 0 && mismatches_net == 0 && mismatches_cos == 0;
    println!("EQUIVALENCE {}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        std::process::exit(1);
    }
    Ok(())
}
