use adblock::Engine;
use staybrave::cosmetic;
use std::collections::HashSet;
use std::io::Write;
use std::time::Instant;

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

fn main() -> anyhow::Result<()> {
    let out_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "StayBrave.txt".into());

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

    let t = Instant::now();
    let (subsumed, removed) = cosmetic::subsume(&cosmetic_lines);
    let kept: HashSet<String> = subsumed.into_iter().collect();
    println!(
        "[{:4}ms] subsume: removed {removed} of {} cosmetic rules",
        t.elapsed().as_millis(),
        cosmetic_lines.len()
    );
    std::io::stdout().flush().unwrap();

    let after_lines: Vec<String> = lines
        .iter()
        .filter(|l| !is_cosmetic(l) || kept.contains(*l))
        .cloned()
        .collect();

    let t = Instant::now();
    let before = Engine::new_with_list_text(lines.join("\n"));
    println!("[{:4}ms] built before engine", t.elapsed().as_millis());
    let t = Instant::now();
    let after = Engine::new_with_list_text(after_lines.join("\n"));
    println!("[{:4}ms] built after engine", t.elapsed().as_millis());
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

    let t = Instant::now();
    let mut mismatches = 0usize;
    let mut checked = 0usize;
    for host in &hosts {
        let url = format!("https://{host}/");
        let ra = before.url_cosmetic_resources(&url);
        let rb = after.url_cosmetic_resources(&url);
        if !compare_resources(&ra, &rb) {
            mismatches += 1;
            if mismatches <= 5 {
                let diff_hide: Vec<_> = ra
                    .hide_selectors
                    .difference(&rb.hide_selectors)
                    .take(5)
                    .collect();
                let diff_proc: Vec<_> = ra
                    .procedural_actions
                    .difference(&rb.procedural_actions)
                    .take(5)
                    .collect();
                let diff_exc: Vec<_> = ra.exceptions.difference(&rb.exceptions).take(5).collect();
                let diff_hide_extra: Vec<_> = rb
                    .hide_selectors
                    .difference(&ra.hide_selectors)
                    .take(5)
                    .collect();
                eprintln!(
                    "MISMATCH {host}:\n  hide only-before={diff_hide:?}\n  hide only-after={diff_hide_extra:?}\n  proc only-before={diff_proc:?}\n  exc only-before={diff_exc:?}\n  inj only-before={:?}\n  inj only-after={:?}\n  genhide {}/{}",
                    ra.injected_script.strip_prefix(&rb.injected_script).unwrap_or("(len differs)"),
                    rb.injected_script.strip_prefix(&ra.injected_script).unwrap_or("(len differs)"),
                    ra.generichide,
                    rb.generichide
                );
            }
        }
        checked += 1;
    }
    println!(
        "[{:4}ms] compared {} url_cosmetic_resources checks: {mismatches} mismatches",
        t.elapsed().as_millis(),
        checked
    );
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let ca = before.hidden_class_id_selectors(&classes, &ids, &HashSet::new());
    let cb = after.hidden_class_id_selectors(&classes, &ids, &HashSet::new());
    let generic_ok = ca == cb;
    println!(
        "[{:4}ms] generic class/id path identical: {generic_ok} ({} selectors)",
        t.elapsed().as_millis(),
        ca.len()
    );
    if !generic_ok {
        mismatches += 1;
    }
    std::io::stdout().flush().unwrap();

    let t = Instant::now();
    let a_ser = before.serialize();
    let t_ser_a = t.elapsed().as_millis();
    let t = Instant::now();
    let b_ser = after.serialize();
    let t_ser_b = t.elapsed().as_millis();
    let b_ser2 = after.serialize();
    let deterministic = b_ser == b_ser2;
    println!(
        "serialize: before {:.2} MB in {t_ser_a}ms, after {:.2} MB in {t_ser_b}ms (deterministic: {deterministic})",
        a_ser.len() as f64 / 1e6,
        b_ser.len() as f64 / 1e6
    );
    std::io::stdout().flush().unwrap();

    println!(
        "summary: -{removed} cosmetic rules, {} before -> {} after lines",
        lines.len(),
        after_lines.len()
    );

    let ok = mismatches == 0;
    println!("EQUIVALENCE {}", if ok { "PASS" } else { "FAIL" });
    if !ok {
        std::process::exit(1);
    }
    Ok(())
}
