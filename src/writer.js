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
        `!   [ok]   ${s.name}: ${s.bytes} bytes (+${s.included_files} included files), ${s.total_lines} lines, ${s.network_rules} network + ${s.cosmetic_rules} cosmetic rules (incl. scriptlets ${extra}), ${s.empty} empty, ${s.unsupported} unsupported, ${s.invalid} invalid, ${s.hosts_converted} hosts entries converted, ${s.scriptlets_removed} scriptlets filtered, ${s.unsupported_options} unsupported options, ${s.trusted_source_dropped} trusted-source dropped, ${s.unsupported_cosmetic} unsupported cosmetic rules, ${s.cosmetic_transforms} rewrites`
      );
    } else {
      chunks.push(`!   [fail] ${s.name}: fetch failed (${s.error ?? 'unknown'})`);
    }
  }
  chunks.push('!');

  chunks.push(
    `! Input rules: ${optimized.input_rules} | Unique output: ${optimized.unique_rules} | Final output: ${optimized.rules.length} | Duplicates removed: ${optimized.duplicates_removed} | Cosmetic subsumed: ${optimized.cosmetic_selectors_subsumed} | Procedural subsumed: ${optimized.procedural_subsumed} | Network subsumed: ${optimized.network_subsumed}`
  );
  if (optimized.canonicalized_rules > 0) {
    chunks.push(
      `! Rewrites: ${optimized.canonicalized_rules} net-option spelling(s) canonicalized (uBO synonym map; duplicates collapsed)`
    );
  }
  chunks.push(
    `! Engine-filtered cosmetics (dead in stock uBO): ${optimized.cosmetic_engine_dropped ?? 0}`
  );
  if ((optimized.cosmetic_dead_candidates_count ?? 0) > 0) {
    chunks.push(
      `! Cosmetic dead-hide gate (engine-certified removals): ${optimized.cosmetic_dead_removed ?? 0} removed of ${optimized.cosmetic_dead_candidates_count} candidate(s) with their hide already withdrawn by an exception`
    );
  }
  if ((optimized.cosmetic_dead_exception_candidates_count ?? 0) > 0) {
    chunks.push(
      `! Cosmetic dead-exception gate (engine-certified removals): ${optimized.cosmetic_dead_exception_removed ?? 0} removed of ${optimized.cosmetic_dead_exception_candidates_count} candidate(s) whose selector no hide uses`
    );
  }
  chunks.push(
    `! Wildcard-TLD $domain rules (kept to avoid broadening): ${optimized.wildcard_domain_rules}`
  );
  if ((optimized.superset_candidates ?? 0) > 0) {
    chunks.push(
      `! Superset gate (engine-certified removals): ${optimized.superset_removed ?? 0} removed of ${optimized.superset_candidates} candidate(s) probed through uBO's own static network engine`
    );
  }
  if ((optimized.engine_dead_exception_candidates_count ?? 0) > 0) {
    chunks.push(
      `! Dead-exception gate (engine-certified removals): ${optimized.engine_dead_exception_removed ?? 0} removed of ${optimized.engine_dead_exception_candidates_count} candidate(s) that uBO proves suppress no surviving block`
    );
  }
  const tb = optimized.token_buckets ?? {};
  const tk = tb.tokened ?? optimized.hostname_tokened ?? 0;
  const jo = tb.justOrigin ?? optimized.just_origin ?? 0;
  const ca = tb.catchAll ?? optimized.catch_all_estimated ?? 0;
  chunks.push(
    `! Token buckets (SNFE-mirrored): ${tk} tokened, ${jo} just-origin, ${ca} catch-all network rules (last two are visited on every request)`
  );
  const eff = optimized.efficiency ?? {};
  if (eff.network !== undefined) {
    chunks.push(
      `! Efficiency (SNFE dispatch): network ${eff.network.grade} (${(eff.network.score * 100).toFixed(1)}%) | cosmetic ${eff.cosmetic.grade} (${(eff.cosmetic.score * 100).toFixed(1)}%)`
    );
  }
  chunks.push(
    `! Cosmetic channels: ${optimized.simple_class_id} simple class/id, ${optimized.complex_token_led} complex token-led, ${optimized.generic_misc} generic-misc, ${optimized.hostname_hide} hostname-hide, ${optimized.hostname_unhide} hostname-unhide, ${optimized.procedural} procedural`
  );
  chunks.push('!');
  chunks.push('! Built for Firefox uBO, where the exclusive capabilities live:');
  chunks.push(
    `!   ... CNAME uncloaking + $ipaddress= rules, ##^ HTML filters, ^responseheader filters, scriptlets`
  );
  const fe = optimized.firefox_exclusive ?? {};
  chunks.push(
    `! Firefox-exclusive rules shipped: ${fe.html_filters ?? 0} html_filters, ${fe.responseheaders ?? 0} responseheaders, ${fe.scriptlets ?? 0} scriptlets, ${fe.ipaddress ?? 0} ipaddress, ${fe.cname ?? 0} cname, ${fe.csp ?? 0} csp` +
      (fe.replace > 0 || fe.uritransform > 0 || fe.urlskip > 0
        ? ` | trusted-only: ${fe.replace ?? 0} replace, ${fe.uritransform ?? 0} uritransform, ${fe.urlskip ?? 0} urlskip`
        : '')
  );
  chunks.push('! Every rule below is validated by the uBlock Origin 1.74+ static-filter parser.');
  chunks.push(
    '! Unsupported uBO scriptlet injections, trusted-only ($replace=, $uritransform, $urlskip,'
  );
  chunks.push(
    '! trusted-* scriptlets) and dead syntax are removed unless keep_trusted_only is enabled;'
  );
  chunks.push(
    '! when enabled, add this list\'s URL to uBO\'s trustedListPrefixes advanced setting.'
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