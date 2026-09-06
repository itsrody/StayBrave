// Pipeline driver: fetch -> include/conditional expansion -> analyze each
// source -> merge -> dedup/sort -> network + cosmetic subsumption -> write.

import { Fetcher } from './fetch.js';
import { analyzeText, emptyStats } from './analyze.js';
import { optimize } from './optimize.js';
import { writeOutput } from './writer.js';

export async function runPipeline(config, { offline = false, outputPath } = {}) {
  const fetcher = new Fetcher({ ...config.fetch, offline });
  const fetched = await fetcher.fetchAll(config.lists);

  const summaries = [];
  const allRules = [];
  let sourcesOk = 0;

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
      source.hosts
    );
    Object.assign(summary, stats);
    summaries.push(summary);
    for (const line of lines) allRules.push(line);
  }

  const optimized = optimize(allRules, config.filter);

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