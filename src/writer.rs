use crate::optimizer::OptimizedRules;
use anyhow::{Context, Result};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use time::OffsetDateTime;

#[derive(Debug, Clone)]
pub struct ListSummary {
    pub name: String,
    pub ok: bool,
    pub bytes: Option<usize>,
    pub included_files: u64,
    pub total_lines: u64,
    pub network_rules: u64,
    pub cosmetic_rules: u64,
    pub empty: u64,
    pub unsupported: u64,
    pub invalid: u64,
    pub scriptlets_removed: u64,
    pub redirects_removed: u64,
    pub hosts_converted: u64,
    pub unsupported_options: u64,
    pub unsupported_cosmetic: u64,
}

pub fn write_output(
    path: &Path,
    rules: &OptimizedRules,
    summaries: &[ListSummary],
) -> Result<()> {
    let mut w = BufWriter::new(
        File::create(path).with_context(|| format!("creating {}", path.display()))?,
    );

    let now = OffsetDateTime::now_utc();
    writeln!(w, "! StayBrave - optimized adblock-rust filter list")?;
    writeln!(
        w,
        "! Generated: {:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )?;
    writeln!(w, "!")?;

    let fetched = summaries.iter().filter(|s| s.ok).count();
    writeln!(w, "! Sources ({fetched}/{} fetched):", summaries.len())?;
    for s in summaries {
        if s.ok {
            writeln!(
                w,
                "!   [ok]   {}: {} bytes (+{} included files), {} lines, {} network + {} cosmetic rules, {} empty, {} unsupported, {} invalid, {} hosts entries converted, {} scriptlets + {} redirects filtered, {} unsupported options, {} unsupported cosmetic rules",
                s.name,
                s.bytes.unwrap_or(0),
                s.included_files,
                s.total_lines,
                s.network_rules,
                s.cosmetic_rules,
                s.empty,
                s.unsupported,
                s.invalid,
                s.hosts_converted,
                s.scriptlets_removed,
                s.redirects_removed,
                s.unsupported_options,
                s.unsupported_cosmetic
            )?;
        } else {
            writeln!(w, "!   [fail] {}: fetch failed", s.name)?;
        }
    }
    writeln!(w, "!")?;

    let total_network: u64 = summaries.iter().map(|s| s.network_rules).sum();
    let total_cosmetic: u64 = summaries.iter().map(|s| s.cosmetic_rules).sum();
    let total_scriptlets: u64 = summaries.iter().map(|s| s.scriptlets_removed).sum();
    let total_redirects: u64 = summaries.iter().map(|s| s.redirects_removed).sum();
    let total_hosts: u64 = summaries.iter().map(|s| s.hosts_converted).sum();
    let total_uopts: u64 = summaries.iter().map(|s| s.unsupported_options).sum();
    let total_ucosm: u64 = summaries.iter().map(|s| s.unsupported_cosmetic).sum();
    writeln!(
        w,
        "! Input rules: {} | Unique output: {} | Duplicates removed: {}",
        rules.input_rules, rules.unique_rules, rules.duplicates_removed
    )?;
    writeln!(
        w,
        "! Validated: {} network + {} cosmetic rules (adblock-rust parser)",
        total_network, total_cosmetic
    )?;
    writeln!(
        w,
        "! Filtered as unsupported: {} scriptlets + {} redirects",
        total_scriptlets, total_redirects
    )?;
    writeln!(
        w,
        "! Normalized: {} hosts entries converted | Eliminated: {} unsupported options, {} unsupported cosmetic rules",
        total_hosts, total_uopts, total_ucosm
    )?;
    writeln!(w, "!")?;
    writeln!(
        w,
        "! Every rule below is validated by the adblock-rust engine parser."
    )?;
    writeln!(
        w,
        "! Unsupported uBO scriptlet injection and unlisted $redirect resources are removed."
    )?;

    for rule in &rules.rules {
        writeln!(w, "{rule}")?;
    }

    w.flush()?;
    Ok(())
}
