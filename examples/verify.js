// Independent gate before a build is committed: parse the final list 100%
// error-free with uBO's static-filter parser, compile the whole file through
// the real StaticNetworkFilteringEngine (SNFE), and probe a sample of the
// simple option-less network rules with synthetic requests to prove they are
// live (nothing was over-staticized/dropped by the optimizer). Also reports
// how many network units the engine actually registers (getFilterCount, the
// same number uBO's dashboard "used" counter derives from) and proves that
// supported modifier rules ($removeparam, $csp, $permissions, $uritransform)
// answer through the engine's modifier APIs.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import snfe from '@gorhill/ubo-core/js/static-net-filtering.js';
import { AstFilterParser } from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { parseSimpleRule } from '../src/network.js';

const MODIFIER_PROBE_LIMIT = 200;

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
const modifierProbes = { removeparam: [], csp: [], permissions: [], uritransform: [] };

function hostFromHostAnchor(line) {
  const rest = line.slice(2);
  const end = rest.indexOf('$');
  const hostPart = end === -1 ? rest : rest.slice(0, end);
  if (!hostPart.endsWith('^') || hostPart.startsWith('.')) {
    return null;
  }
  const host = hostPart.slice(0, -1);
  if (/^[a-z0-9.*-]+$/.test(host) === false || host.includes('.') === false) {
    return null;
  }
  return host;
}

function removeparamProbeQuery(value, token) {
  if (value === '' || value === '1') return `?utm_source=${token}&keep=1`;
  if (value.startsWith('/') && value.endsWith('/') && value.length > 2) {
    const core = value
      .slice(1, -1)
      .replace(/^[\\^]*\^?/, '')
      .replace(/\\?\$$/, '')
      .replace(/[^a-z0-9_.-]/gi, '');
    return core.length > 0 ? `?${core}=${token}&keep=1` : null;
  }
  if (/[~|=]/.test(value)) return null;
  return `?${value}=${token}&keep=1`;
}

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
  const mod = line.startsWith('||') ? line.slice(line.indexOf('$') + 1) : '';
  const modName = mod.match(/^(removeparam|csp|permissions|uritransform)=?/)?.[1];
  if (
    modName !== undefined &&
    line.startsWith('@@') === false &&
    mod.includes(',') === false &&
    modifierProbes[modName].length < MODIFIER_PROBE_LIMIT
  ) {
    const host = hostFromHostAnchor(line);
    if (host !== null) {
      modifierProbes[modName].push({ raw: line, host, value: mod.slice(modName.length + 1) });
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
const kinds = new Set(['network', 'cosmetic']);
const kindCounts = { network: 0, cosmetic: 0, other: 0 };
for (const l of rules) {
  const idx = Math.max(l.indexOf('#@#'), l.indexOf('##'), l.indexOf('#?#'));
  const kind = idx === -1 ? 'network' : 'cosmetic';
  if (kinds.has(kind)) kindCounts[kind] += 1;
  else kindCounts.other += 1;
}
const events = [];
const snfeProxy = await StaticNetFilteringEngine.create();
await snfeProxy.useLists([{ name: outputPath, raw: text }], { events });
if (events.length > 0) {
  console.error(`SNFE dropped ${events.length} lines during compilation:`);
  for (const ev of events.slice(0, 20)) console.error('  ', ev.text);
  process.exitCode = 1;
} else {
  console.log(`SNFE compiled the full file with zero dropped lines`);
}

// Engine registration metric: getFilterCount() is the number of network units
// the engine actually registered (the value behind uBO's dashboard "used"
// counter). Cosmetic rules never enter the SNFE, so the baseline is the number
// of network lines; a large shortfall would mean the engine silently lost rules.
const networkLineCount = kindCounts.network;
const registeredUnits = snfe.getFilterCount();
const unitDelta = registeredUnits - networkLineCount;
const note =
  unitDelta >= 0
    ? `(+${unitDelta} net units from $redirect / split options)`
    : `(${unitDelta} network rules did not register)`;
console.log(
  `engine registration: ${registeredUnits} units registered vs ${networkLineCount} network lines ${note}`
);
if (registeredUnits < networkLineCount * 0.98) {
  console.error(
    `engine registered only ${registeredUnits} units for ${networkLineCount} network lines`
  );
  process.exitCode = 1;
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
  const res = await snfeProxy.matchRequest({
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

// Modifier probes: prove supported modifier rules are answered by the engine.
// Only host-anchored rules with the modifier as their single option qualify,
// so a synthetic request against the rule's host must trigger the modifier.
// ($redirect/$redirect-rule are intentionally absent: this ubo-core build does
// not surface them via the engine, requiring an external RedirectEngine.)
let modOkTotal = 0;
let modFailTotal = 0;
let modSkipTotal = 0;
for (const [name, targets] of Object.entries(modifierProbes)) {
  if (targets.length === 0) continue;
  let ok = 0;
  let fail = 0;
  let skip = 0;
  for (const t of targets) {
    const token = Math.random().toString(36).slice(2, 10);
    const baseUrl = `http://${t.host}/probe-${token}.js`;
    const details = {
      url: baseUrl,
      originURL: `http://origin-${token}.example.net/`,
      type: name === 'removeparam' ? 'script' : 'main_frame',
      tabId: 1,
      docId: 1,
      frameId: 0,
    };
    let matched;
    if (name === 'removeparam') {
      const query = removeparamProbeQuery(t.value, token);
      if (query === null) {
        skip += 1;
        continue;
      }
      const r = await snfeProxy.filterQuery({ ...details, url: baseUrl + query });
      matched = r !== undefined && r.directives !== undefined && r.directives.length > 0;
    } else {
      const r = await snfeProxy.matchAndFetchModifiers({ ...details, url: baseUrl }, name);
      matched = r !== undefined && r.length > 0;
    }
    if (matched) ok += 1;
    else {
      fail += 1;
      if (fail <= 3) console.error('  modifier not answering:', t.raw, '(' + name + ')');
    }
  }
  modOkTotal += ok;
  modFailTotal += fail;
  modSkipTotal += skip;
  const probed = targets.length - skip;
  const verdict = fail > 0 ? 'partial' : 'all';
  console.log(`modifier probes ($${name}): ${ok}/${probed} matched [${verdict}${skip > 0 ? `, ${skip} skipped` : ''}]`);
  if (ok === 0 && probed > 0) process.exitCode = 1;
}
if (modOkTotal + modFailTotal + modSkipTotal > 0) {
  const sk = modSkipTotal > 0 ? `, ${modSkipTotal} skipped` : '';
  console.log(`modifier probes: ${modOkTotal} matched / ${modFailTotal} failed${sk}`);
}

const kinds2 = { network: kindCounts.network, cosmetic: kindCounts.cosmetic };
console.log(
  `output: ${rules.length} rules (${kinds2.network} network, ${kinds2.cosmetic} cosmetic)`
);
console.log(`exit: ${process.exitCode === 1 ? 'FAIL' : 'PASS'}`);