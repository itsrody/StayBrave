use staybrave::rewriter::Rewriter;
use std::path::PathBuf;

fn main() {
    let path = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("StayBrave.txt"));

    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("reading {}: {e}", path.display()));

    let rules: Vec<String> = text
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim_start().starts_with('!'))
        .map(|l| l.trim().to_string())
        .collect();

    let rewriter = Rewriter::default();
    let report = rewriter.rewrite_list(rules);

    let s = &report.stats;
    println!(
        "input            : {} rules ({} network, {} cosmetic)",
        s.total, s.network, s.cosmetic
    );
    println!(
        "regex-backed     : {} ({:.1}% of network)",
        s.regex,
        pct(s.regex, s.network)
    );
    println!("  complete regex : {}", s.complete_regex);
    println!("explicit $all    : {}", s.with_all);
    println!("domain options   : {}", s.with_domains);
    println!("modifier (redirect/csp/etc): {}", s.with_modifier);
    println!("trimmable '*'    : {}", s.trimmable_wildcards);
    println!("mixed-case       : {}", s.mixed_case);
    println!("rewritten        : {}", s.rewritten);
    println!(
        "semantic unique  : {}  (merged {} duplicates)",
        s.kept, s.merged_duplicates
    );

    let mut cats: Vec<_> = report.samples.keys().collect();
    cats.sort();
    for cat in cats {
        let v = &report.samples[cat];
        println!("\n[{cat}] ({})", v.len());
        for l in v {
            println!("  {l}");
        }
    }
}

fn pct(n: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        100.0 * n as f64 / total as f64
    }
}
