// Pipeline driver: fetch -> include/conditional expansion -> analyze each
// source -> merge -> dedup/sort -> network + cosmetic subsumption -> write.

import { Fetcher } from './fetch.js';
import { analyzeText, emptyStats } from './analyze.js';
import { makeParser, TRUSTED_SCRIPTLET_TOKENS } from './ubo.js';
import { optimize } from './optimize.js';
import { subtractProvided } from './provided.js';
import { writeOutput } from './writer.js';

// Collect the active rule lines of an already-enabled external list (uBO
// built-ins, EasyList-in-browser, …): expand !#include, drop comments/headers,
// and keep every remaining non-empty line as provided coverage.
async function collectProvidedLines(fetcher, list) {
  const { text } = await fetcher.fetchList(list);
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim().replace(/\s+$/, '');
    if (t === '' || t.startsWith('!') || t.startsWith('[')) continue;
    out.push(t);
  }
  return out;
}

export async function runPipeline(config, { offline = false, outputPath } = {}) {
  const fetcher = new Fetcher({ ...config.fetch, offline });
  const fetched = await fetcher.fetchAll(config.lists);

  const summaries = [];
  const allRules = [];
  let sourcesOk = 0;

  // One parser for the whole run, mirroring uBO's own single-instance reuse:
  // constructor cost is paid once and per-line `parse()` is fully
  // state-independent between calls.
  const parser = makeParser({
    keep_trusted_only: config.filter.keep_trusted_only,
    trustedScriptletTokens: TRUSTED_SCRIPTLET_TOKENS,
  });

  for (const { source, result } of fetched) {
    const summary = { name: source.name, ok: false, ...emptyStats(), error: null };
    if (!result.ok) {
      summary.error = result.error;
      summaries.push(summary);
      continue;
    }
    sourcesOk += 1;
    summary.ok = true;
    summary.bytes = result.bytes;
    summary.included_files = result.includedFiles;
    summary.from_cache = result.rootFromCache === true;

    const { lines, stats } = analyzeText(
      result.text,
      config.filter,
      source.hosts,
      parser
    );
    Object.assign(summary, stats);
    summaries.push(summary);
    for (const line of lines) allRules.push(line);
  }

  const optimized = optimize(allRules, config.filter);

  // Subtract rules already provided by external lists the user enables.
  const providedLines = [];
  for (const list of config.provided_lists ?? []) {
    try {
      providedLines.push(...(await collectProvidedLines(fetcher, list)));
    } catch (err) {
      process.stderr.write(
        `[warn] provided list ${list.name}: ${err.message}\n`
      );
    }
  }
  if (providedLines.length > 0) {
    const subtraction = subtractProvided(optimized.rules, providedLines);
    optimized.rules = subtraction.rules;
    optimized.provided_rules = providedLines.length;
    optimized.provided_exact_removed = subtraction.exactRemoved.length;
    optimized.provided_network_subsumed = subtraction.networkSubsumed;
    optimized.provided_cosmetic_covered = subtraction.cosmeticCovered;
  } else {
    optimized.provided_rules = 0;
    optimized.provided_exact_removed = 0;
    optimized.provided_network_subsumed = 0;
    optimized.provided_cosmetic_covered = 0;
  }

  const outPath = outputPath ?? config.output.file;
  writeOutput(outPath, config.output, optimized, summaries);

  return {
    optimized,
    summaries,
    sourcesOk,
    sourcesFailed: summaries.length - sourcesOk,
    bytesTransferred: fetcher.bytesTransferred,
    fetchedFromCache: fetcher.fetchedFromCache,
    outputPath: outPath,
  };
}