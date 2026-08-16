use adblock::Engine;
use staybrave::cosmetic;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write;
use std::time::Instant;

#[derive(Debug, Clone)]
struct SimpleRule {
    raw: String,
    host: String,
    path: String,
}

fn parse_simple_rule(raw: &str) -> Option<SimpleRule> {
    if raw.contains('*') || raw.contains('$') || raw.contains("@@") {
        return None;
    }
    let body = raw.strip_prefix("||")?;
    if !body.ends_with('^') {
        return None;
    }
    let body = &body[..body.len() - 1];
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

fn request_for(rule: &SimpleRule, source: &str) -> adblock::request::Request {
    let path = if rule.path.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", rule.path)
    };
    let url = format!("https://{}{}", rule.host, path);
    adblock::request::Request::new(&url, source, "other", "GET").unwrap()
}

fn suffixes(host: &str) -> impl Iterator<Item = &str> {
    let mut h = host;
    std::iter::from_fn(move || {
        if h.is_empty() {
            return None;
        }
        let out = h;
        match h.find('.') {
            Some(i) => h = &h[i + 1..],
            None => h = "",
        }
        Some(out)
    })
}

/// Count how many simple no-option block rules are subsumed by a broader rule
/// (host-suffix or same-host path-prefix). Removing them changes no request.
fn count_subsumable(rules: &[String]) -> (usize, usize) {
    let mut items: Vec<(usize, usize, String, String)> = Vec::new();
    for raw in rules {
        if raw.starts_with("@@") {
            continue;
        }
        if let Some(r) = parse_simple_rule(raw) {
            items.push((r.host.len(), r.path.len(), r.host, r.path));
        }
    }
    items.sort();
    let mut broad_hosts: HashSet<String> = HashSet::new();
    let mut host_paths: HashMap<String, HashSet<String>> = HashMap::new();
    let mut kept = 0usize;
    for (_, _, host, path) in &items {
        let covered = suffixes(host).any(|h| broad_hosts.contains(h));
        let covered = covered
            || (!path.is_empty()
                && path
                    .split('/')
                    .scan(String::new(), |acc, part| {
                        if acc.is_empty() {
                            acc.push_str(part);
                        } else {
                            acc.push('/');
                            acc.push_str(part);
                        }
                        Some(acc.clone())
                    })
                    .take_while(|p| p != path)
                    .any(|p| host_paths.get(host).is_some_and(|s| s.contains(&p))));
        if covered {
            continue;
        }
        kept += 1;
        if path.is_empty() {
            broad_hosts.insert(host.clone());
        } else {
            host_paths
                .entry(host.clone())
                .or_default()
                .insert(path.clone());
        }
    }
    (items.len(), kept)
}

/// Operators dead in Brave with no safe rewrite. A surviving rule containing
/// any of these is a bug (the transform layer should have dropped or rewritten
/// it).
const KILL_OPS: &[&str] = &[
    ":contains(",
    ":-abp-contains(",
    ":others(",
    ":matches-media(",
    ":watch-attr(",
    ":-abp-properties(",
    ":nth-ancestor(",
    ":matches-prop(",
    ":remove-attr()",
    ":remove-class()",
    ":style()",
];

/// Operators and actions the Brave procedural engine executes on a single
/// simple selector. Any comma list containing one of these must have been
/// split by the transform layer.
const EXEC_OPS: &[&str] = &[
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

fn has_op(selector: &str, ops: &[&str]) -> bool {
    ops.iter().any(|op| selector.contains(op))
}

/// Find cosmetic rules that survived with a dead operator or an unsplit comma
/// list containing a procedural/action operator.
fn find_cosmetic_contamination(lines: &[String]) -> Vec<String> {
    let mut bad = Vec::new();
    for line in lines {
        let Some((idx, sep)) = ["#@#", "##", "#?#"]
            .iter()
            .find_map(|sep| line.find(sep).map(|i| (i, *sep)))
        else {
            continue;
        };
        let selector = &line[idx + sep.len()..];
        if sep == "#?#" {
            continue;
        }
        if has_op(selector, KILL_OPS) {
            bad.push(format!("dead operator: {line}"));
        } else if cosmetic::contains_top_level(selector, ',') && has_op(selector, EXEC_OPS) {
            bad.push(format!("unsplit comma+op: {line}"));
        }
    }
    bad
}

fn main() -> anyhow::Result<()> {
    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "StayBrave.txt".into());
    let sample: usize = std::env::var("VERIFY_SAMPLE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(50_000);
    let baseline_rules: Option<usize> = std::env::var("VERIFY_BASELINE_RULES")
        .ok()
        .and_then(|s| s.parse().ok());

    let t0 = Instant::now();
    let lines: Vec<String> = std::fs::read_to_string(&out_path)?
        .lines()
        .map(|l| l.to_string())
        .collect();
    let bytes: usize = lines.iter().map(|l| l.len() + 1).sum();
    println!(
        "[{:4}ms] read {} lines ({:.1} MB)",
        t0.elapsed().as_millis(),
        lines.len(),
        bytes as f64 / 1e6
    );
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let contamination = find_cosmetic_contamination(&lines);
    println!(
        "[{:4}ms] cosmetic gate: {} contaminated rules (dead ops or unsplit comma+op)",
        t.elapsed().as_millis(),
        contamination.len()
    );
    for c in contamination.iter().take(20) {
        eprintln!("  {c}");
    }
    std::io::stdout().flush().unwrap();

    // Rules cancelled by a $badfilter twin are expected to not match.
    let badfiltered: HashSet<String> = lines
        .iter()
        .filter_map(|l| l.strip_suffix("$badfilter").map(|t| t.to_string()))
        .collect();

    let t = Instant::now();
    let (n, kept) = count_subsumable(&lines);
    let subsumable = n - kept;
    let est = subsumable as f64 * (bytes as f64 / lines.len() as f64) / 1e6;
    println!(
        "[{:4}ms] efficiency: {} subsumable of {} analyzed -> best-effort min ~{} rules, saving ~{:.2} MB",
        t.elapsed().as_millis(),
        subsumable,
        n,
        lines.len() - subsumable,
        est
    );
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let engine = Engine::new_with_list_text(lines.join("\n"));
    println!(
        "[{:4}ms] engine build from {out_path}",
        t.elapsed().as_millis()
    );
    std::io::stdout().flush().unwrap();

    let all: Vec<SimpleRule> = lines.iter().filter_map(|r| parse_simple_rule(r)).collect();
    let step = if all.len() > sample {
        all.len() / sample
    } else {
        1
    };
    let corpus: Vec<&SimpleRule> = all.iter().step_by(step).collect();
    let t = Instant::now();
    let mut dead = 0usize;
    let mut expected_dead = 0usize;
    for rule in &corpus {
        let req = request_for(rule, "https://www.example.com/");
        let res = engine.check_network_request(&req);
        if res.filter.is_none() && res.exception.is_none() {
            if badfiltered.contains(&rule.raw) {
                expected_dead += 1;
            } else {
                if dead < 20 {
                    eprintln!("DEAD (unexplained): {}", rule.raw);
                }
                dead += 1;
            }
        }
    }
    let per_us = t.elapsed().as_secs_f64() / corpus.len() as f64 * 1e6;
    println!(
        "[{:4}ms] liveness: sampled {}/{} rules, {} dead, {} expected-dead (badfilter) ({:.1} us/check)",
        t.elapsed().as_millis(),
        corpus.len(),
        all.len(),
        dead,
        expected_dead,
        per_us
    );
    std::io::stdout().flush().unwrap();

    if let Some(baseline) = baseline_rules {
        let growth = lines.len() as i64 - baseline as i64;
        let pct = 100.0 * growth as f64 / baseline as f64;
        let flag = if growth > 0 { "WARN" } else { "ok" };
        println!("regression vs baseline: {growth:+} rules ({pct:+.1}%) [{flag}]");
        std::io::stdout().flush().unwrap();
    }

    let ok = dead == 0 && contamination.is_empty();
    println!("VERIFY {}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        std::process::exit(1);
    }
    Ok(())
}
