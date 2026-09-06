// Independent gate before a build is committed: parse the final list 100%
// error-free with uBO's static-filter parser, compile the whole file through
// the real StaticNetworkFilteringEngine (SNFE), and probe a sample of the
// simple option-less network rules with synthetic requests to prove they are
// live (nothing was over-staticized/dropped by the optimizer).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import { AstFilterParser } from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { parseSimpleRule } from '../src/network.js';

const outputPath = resolve(process.argv[2] ?? 'output/StayBrave-Classic.txt');
const probeLimit = Number(process.argv[3] ?? 2000);

const text = readFileSync(outputPath, 'utf8');
const lines = text.split('\n');
const rules = lines.filter(
  (l) => l !== '' && !l.startsWith('[') && !l.startsWith('!')
);

let failed = 0;
const byError = new Map();
const parser = new AstFilterParser({ interactive: true, trustedSource: false });
const probed = [];

for (const line of rules) {
  if (probed.length < probeLimit) {
    const simple = parseSimpleRule(line);
    if (
      simple !== null &&
      !simple.host.startsWith('.') &&
      simple.host.includes('.')
    ) {
      probed.push(simple);
    }
  }
  parser.parse(line);
  const err = parser.astError;
  if (err !== 0) {
    failed += 1;
    byError.set(err, (byError.get(err) ?? 0) + 1);
    if (failed <= 5) console.error('  parser error:', line, 'astError=', err);
  }
}

if (failed > 0) {
  console.error(
    `source parser: ${failed} lines carry errors:`,
    Object.fromEntries([...byError].map(([k, v]) => [k, v]))
  );
  process.exitCode = 1;
} else {
  console.log(`source parser: ${rules.length} rules all clean`);
}

// Compile through the real engine; uBO surfaces dropped lines via events.
const events = [];
const snfe = await StaticNetFilteringEngine.create();
await snfe.useLists([{ name: outputPath, raw: text }], { events });
if (events.length > 0) {
  console.error(`SNFE dropped ${events.length} lines during compilation:`);
  for (const ev of events.slice(0, 20)) console.error('  ', ev.text);
  process.exitCode = 1;
} else {
  console.log(`SNFE compiled the full file with zero dropped lines`);
}

// Liveness probes: every probed simple option-less rule must actually block a
// synthetic request, otherwise the optimizer mis-dropped it.
let blockFails = 0;
let blockOk = 0;
for (const r of probed) {
  const token = Math.random().toString(36).slice(2, 10);
  const url =
    r.path === ''
      ? `http://${r.host}/probe-${token}.js`
      : `http://${r.host}/${r.path}/probe-${token}.js`;
  const res = await snfe.matchRequest({
    url,
    originURL: `http://origin-${token}.example.net/`,
    type: 'script',
    tabId: 1,
    docId: 1,
    frameId: 0,
  });
  if ((res & 1) === 0) {
    blockFails += 1;
    if (blockFails <= 5) console.error('  not blocking:', r.raw, '->', res);
  } else {
    blockOk += 1;
  }
}
console.log(
  `liveness probes: ${blockOk} blocked / ${blockFails} failed (of ${probed.length} probed)`
);
if (blockFails > 0) process.exitCode = 1;

const kinds = new Set(['network', 'cosmetic']);
const kindCounts = { network: 0, cosmetic: 0, other: 0 };
for (const l of rules) {
  const idx = Math.max(l.indexOf('#@#'), l.indexOf('##'), l.indexOf('#?#'));
  const kind = idx === -1 ? 'network' : 'cosmetic';
  if (kinds.has(kind)) kindCounts[kind] += 1;
  else kindCounts.other += 1;
}
console.log(
  `output: ${rules.length} rules (${kindCounts.network} network, ${kindCounts.cosmetic} cosmetic)`
);
console.log(`exit: ${process.exitCode === 1 ? 'FAIL' : 'PASS'}`);