// Output writer: ABP-style header + per-source summary + final stats + rules.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

export function timestamp(now = new Date()) {
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
  ].join('');
}

export function writeOutput(path, outputCfg, optimized, summaries) {
  const now = new Date();
  const chunks = [];
  chunks.push('[Adblock Plus 2.0]');
  chunks.push(`! Title: ${outputCfg.title}`);
  chunks.push(`! Version: ${timestamp(now)}`);
  chunks.push(`! Description: ${outputCfg.description}`);
  chunks.push(`! Expires: ${outputCfg.expires}`);
  chunks.push(`! Homepage: ${outputCfg.homepage}`);
  chunks.push(`! Last modified: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  chunks.push('!');
  chunks.push(`! Generated: ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  chunks.push('!');

  const fetched = summaries.filter((s) => s.ok).length;
  chunks.push(`! Sources (${fetched}/${summaries.length} fetched):`);
  if (summaries.length === 0) {
    chunks.push('!   (none configured)');
  }
  for (const s of summaries) {
    if (s.ok) {
      const extra = [
        s.scriptlets,
        s.html_filters,
        s.responseheaders,
      ].join(' + ');
      chunks.push(
        `!   [ok]   ${s.name}: ${s.bytes} bytes (+${s.included_files} included files), ${s.total_lines} lines, ${s.network_rules} network + ${s.cosmetic_rules} cosmetic rules (incl. scriptlets ${extra}), ${s.empty} empty, ${s.unsupported} unsupported, ${s.invalid} invalid, ${s.hosts_converted} hosts entries converted, ${s.scriptlets_removed} scriptlets filtered, ${s.unsupported_options} unsupported options, ${s.unsupported_cosmetic} unsupported cosmetic rules, ${s.cosmetic_transforms} rewrites`
      );
    } else {
      chunks.push(`!   [fail] ${s.name}: fetch failed (${s.error ?? 'unknown'})`);
    }
  }
  chunks.push('!');

  chunks.push(
    `! Input rules: ${optimized.input_rules} | Unique output: ${optimized.unique_rules} | Final output: ${optimized.rules.length} | Duplicates removed: ${optimized.duplicates_removed} | Cosmetic subsumed: ${optimized.cosmetic_selectors_subsumed} | Procedural subsumed: ${optimized.procedural_subsumed} | Network subsumed: ${optimized.network_subsumed}`
  );
  chunks.push(
    `! Wildcard-TLD $domain rules (kept to avoid broadening): ${optimized.wildcard_domain_rules}`
  );
  chunks.push(
    `! Token buckets (estimated): ${optimized.hostname_tokened} hostname-tokened rules, ${optimized.catch_all_estimated} catch-all network rules (checked on every request)`
  );
  chunks.push(
    `! Cosmetic channels: ${optimized.simple_class_id} simple class/id, ${optimized.complex_token_led} complex token-led, ${optimized.generic_misc} generic-misc, ${optimized.hostname_hide} hostname-hide, ${optimized.hostname_unhide} hostname-unhide, ${optimized.procedural} procedural`
  );
  chunks.push('!');
  chunks.push('! Every rule below is validated by the uBlock Origin 1.74+ static-filter parser.');
  chunks.push(
    '! Unsupported uBO scriptlet injections, trusted-only and dead syntax are removed.'
  );
  chunks.push(
    '! Procedural cosmetic rules are rewritten into forms Firefox uBO executes'
  );
  chunks.push(
    '! (:contains -> :has-text, :nth-ancestor -> :upward, redundant :style stripped).'
  );
  chunks.push(
    '! Redundant network rules are subsumed by broader host/path rules;'
  );
  chunks.push(
    '! $badfilter pairs are stripped; $popup rules are preserved (uBO-native).'
  );
  chunks.push('');

  for (const rule of optimized.rules) {
    chunks.push(rule);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, chunks.join('\n'));
  return rulesCount(optimized);
}

function rulesCount(o) {
  return o.rules.length;
}

export function formatSummaryLines(summaries) {
  const out = [];
  for (const s of summaries) {
    if (s.ok) {
      out.push(
        `${s.name}: ${s.network_rules} network, ${s.cosmetic_rules} cosmetic`
      );
    } else {
      out.push(`${s.name}: FAILED (${s.error})`);
    }
  }
  return out;
}