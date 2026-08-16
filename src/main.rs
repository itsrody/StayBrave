use clap::Parser;
use std::path::PathBuf;
use staybrave::analyzer::Analyzer;
use staybrave::config::Config;
use staybrave::fetcher::Fetcher;
use staybrave::filter::Filterer;
use staybrave::optimizer::optimize;
use staybrave::writer::{ListSummary, write_output};

#[derive(Parser, Debug)]
#[command(
    name = "staybrave",
    version,
    about = "Fetch, analyze, and optimize adblock-rust filter lists into a single sorted StayBrave.txt"
)]
struct Cli {
    #[arg(short, long, default_value = "lists.toml")]
    config: PathBuf,

    #[arg(short, long)]
    output: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("staybrave=info".parse()?),
        )
        .init();

    let cli = Cli::parse();
    let cfg = Config::load(&cli.config)?;

    let enabled = cfg.lists.iter().filter(|l| l.enabled).count();
    tracing::info!(
        total_lists = cfg.lists.len(),
        enabled_lists = enabled,
        "config loaded"
    );

    let fetcher = Fetcher::new(&cfg.fetch)?;
    let results = fetcher.fetch_all(&cfg.lists).await;

    let analyzer = Analyzer::default();
    let filterer = Filterer::new(&cfg.filter);
    let mut all_rules = Vec::new();
    let mut summaries = Vec::new();
    let mut sources_ok = 0usize;
    let mut sources_failed = 0usize;

    for r in &results {
        match &r.result {
            Ok(fetched) => {
                sources_ok += 1;
                let (rules, stats) = analyzer.analyze(fetched, &filterer);
                all_rules.extend(rules);
                tracing::info!(
                    list = %r.source.name,
                    bytes = fetched.bytes,
                    included_files = fetched.included_files,
                    total_lines = stats.total_lines,
                    network = stats.network_rules,
                    cosmetic = stats.cosmetic_rules,
                    empty = stats.empty,
                    unsupported = stats.unsupported,
                    invalid = stats.invalid,
                    scriptlets_removed = stats.scriptlets_removed,
                    redirects_removed = stats.redirects_removed,
                    "analyzed"
                );
                summaries.push(ListSummary {
                    name: r.source.name.clone(),
                    ok: true,
                    bytes: Some(fetched.bytes),
                    included_files: fetched.included_files,
                    total_lines: stats.total_lines,
                    network_rules: stats.network_rules,
                    cosmetic_rules: stats.cosmetic_rules,
                    empty: stats.empty,
                    unsupported: stats.unsupported,
                    invalid: stats.invalid,
                    scriptlets_removed: stats.scriptlets_removed,
                    redirects_removed: stats.redirects_removed,
                });
            }
            Err(e) => {
                sources_failed += 1;
                tracing::error!(list = %r.source.name, "fetch failed: {e}");
                summaries.push(ListSummary {
                    name: r.source.name.clone(),
                    ok: false,
                    bytes: None,
                    included_files: 0,
                    total_lines: 0,
                    network_rules: 0,
                    cosmetic_rules: 0,
                    empty: 0,
                    unsupported: 0,
                    invalid: 0,
                    scriptlets_removed: 0,
                    redirects_removed: 0,
                });
            }
        }
    }

    let optimized = optimize(all_rules);
    let scriptlets_removed: u64 = summaries.iter().map(|s| s.scriptlets_removed).sum();
    let redirects_removed: u64 = summaries.iter().map(|s| s.redirects_removed).sum();
    tracing::info!(
        sources_fetched = sources_ok,
        sources_failed,
        bytes_transferred = fetcher.bytes_transferred(),
        input_rules = optimized.input_rules,
        unique_rules = optimized.unique_rules,
        duplicates_removed = optimized.duplicates_removed,
        scriptlets_removed,
        redirects_removed,
        "optimization complete"
    );

    if optimized.rules.is_empty() {
        anyhow::bail!("no rules produced; refusing to write an empty output file");
    }

    let out_path = cli
        .output
        .unwrap_or_else(|| PathBuf::from(&cfg.output.file));
    write_output(&out_path, &optimized, &summaries)?;
    tracing::info!(
        path = %out_path.display(),
        rules = optimized.unique_rules,
        "wrote output"
    );
    Ok(())
}
