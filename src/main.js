#!/usr/bin/env node

import { resolve } from 'node:path';
import configFromCli from './config.js';
import { runPipeline } from './lib.js';

function usage() {
  console.error(
    [
      'Usage: staybrave [--config <path>] [--output <path>] [--offline]',
      '',
      'Fetch, analyze, and optimize uBlock Origin filter lists into a single',
      'sorted StayBrave-Classic.txt validated by uBO\'s own filter parser.',
      '',
      'Options:',
      '  -c, --config <path>   config file (default: lists.json)',
      '  -o, --output <path>   output file (default: output/StayBrave-Classic.txt)',
      '  --offline             never touch the network; use .cache only',
    ].join('\n')
  );
}

function parseArgs(argv) {
  const cli = { config: 'lists.json', output: null, offline: false, resolve: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-c':
      case '--config':
        cli.config = argv[++i];
        cli.resolve = true;
        break;
      case '-o':
      case '--output':
        cli.output = resolve(process.cwd(), argv[++i]);
        break;
      case '--offline':
        cli.offline = true;
        break;
      case '-h':
      case '--help':
        usage();
        process.exit(0);
        break;
      case '-v':
      case '--version':
        console.log('staybrave 0.2.0');
        process.exit(0);
        break;
      default:
        console.error(`unknown argument: ${arg}`);
        usage();
        process.exit(2);
    }
  }
  return cli;
}

const cli = parseArgs(process.argv.slice(2));

try {
  const config = configFromCli(cli);
  const enabled = config.lists.filter((l) => l.enabled).length;
  const result = await runPipeline(config, {
    offline: cli.offline,
    outputPath: cli.output,
  });

  const fmt = (n) => `${n}`;
  for (const s of result.summaries) {
    if (s.ok) {
      console.log(
        `[ok]   ${s.name}: ${s.bytes} bytes (+${s.included_files} incl), ${s.total_lines} lines -> ${s.network_rules} network + ${s.cosmetic_rules} cosmetic`
      );
    } else {
      console.error(`[fail] ${s.name}: ${s.error}`);
    }
  }
  const o = result.optimized;
  console.log('');
  console.log(
    `input ${fmt(o.input_rules)} rules -> unique ${fmt(o.unique_rules)} -> final ${fmt(o.rules.length)}`
  );
  const trustedDropped = result.summaries.reduce(
    (n, s) => n + (s.trusted_source_dropped ?? 0),
    0
  );
  if (trustedDropped > 0) {
    console.log(
      `trusted-source: ${fmt(trustedDropped)} rule(s) dropped (set filter.keep_trusted_only to retain)`
    );
  }
  console.log(
    `network subsumed: ${fmt(o.network_subsumed)} | scoped subsumed: ${fmt(o.scoped_subsumed)} | cosmetic subsumed: ${fmt(o.cosmetic_selectors_subsumed)} | procedural subsumed: ${fmt(o.procedural_subsumed)}`
  );
  if (o.superset_candidates > 0) {
    console.log(
      `superset gate: ${fmt(o.superset_candidates)} candidate(s) probed through uBO's engine, ${fmt(o.superset_removed)} certified & removed (${fmt(o.superset_candidates - o.superset_removed)} rejected as uncovered)`
    );
  }
  if (o.cosmetic_engine_dropped > 0) {
    console.log(
      `cosmetic engine: ${fmt(o.cosmetic_engine_dropped)} dead rule(s) dropped (stock uBO would ignore them)`
    );
  }
  if (o.cosmetic_dead_candidates_count > 0) {
    console.log(
      `cosmetic dead-hide gate: ${fmt(o.cosmetic_dead_candidates_count)} candidate(s), ${fmt(o.cosmetic_dead_removed)} certified exception-withdrawn & removed`
    );
  }
  if (o.canonicalized_rules > 0) {
    console.log(
      `rewrites: ${fmt(o.canonicalized_rules)} net-option spelling(s) canonicalized to uBO synonyms (alias duplicates collapsed)`
    );
  }
  const eff = o.efficiency ?? {};
  if (eff.network !== undefined) {
    console.log(
      `efficiency: network ${eff.network.grade} (${(eff.network.score * 100).toFixed(1)}%) | cosmetic ${eff.cosmetic.grade} (${(eff.cosmetic.score * 100).toFixed(1)}%) | tokened ${fmt(eff.network.tokened)} | just-origin ${fmt(eff.network.justOrigin)} | catch-all ${fmt(eff.network.catchall)}`
    );
  }
  const fe = o.firefox_exclusive ?? {};
  console.log(
    `Firefox-exclusive: ${fmt(fe.html_filters ?? 0)} html_filters, ${fmt(fe.responseheaders ?? 0)} responseheaders, ${fmt(fe.scriptlets ?? 0)} scriptlets, ${fmt(fe.ipaddress ?? 0)} ipaddress, ${fmt(fe.cname ?? 0)} cname, ${fmt(fe.csp ?? 0)} csp` +
      (fe.replace > 0 || fe.uritransform > 0 || fe.urlskip > 0
        ? ` | trusted-only: ${fmt(fe.replace ?? 0)} replace, ${fmt(fe.uritransform ?? 0)} uritransform, ${fmt(fe.urlskip ?? 0)} urlskip`
        : '')
  );
  if (result.engineRecheck !== null && result.engineRecheck !== undefined) {
    const r = result.engineRecheck;
    console.log(
      `engine coverage recheck: ${fmt(r.verified)}/${fmt(r.sampled)} removed rules still blocked by survivors` +
        (r.unblocked_safe > 0 ? ` | ${fmt(r.unblocked_safe)} exception-cancelled` : '' ) +
        (r.unprobeable > 0 ? ` | ${fmt(r.unprobeable)} unprobeable` : '')
    );
  }
  if (o.provided_rules > 0) {
    console.log(
      `provided (${o.provided_rules} rules): exact ${fmt(o.provided_exact_removed)} dropped | network-subsumed ${fmt(o.provided_network_subsumed)} | cosmetic-covered ${fmt(o.provided_cosmetic_covered)}`
    );
  }
  console.log(
    `sources: ${result.sourcesOk} ok / ${result.sourcesFailed} failed (${enabled} enabled, ${config.lists.length} configured)`
  );
  console.log(
    `concatenated ~${(result.bytesTransferred / 1048576).toFixed(1)} MB fetched, ${result.fetchedFromCache} from cache`
  );
  console.log(`wrote ${result.outputPath}`);
} catch (err) {
  console.error(`staybrave: ${err.message}`);
  process.exit(1);
}