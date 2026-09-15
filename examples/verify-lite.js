// Independent gate for the lite (uBO Lite / MV3) build before it is released:
// re-parse every emitted rule 100% error-free with uBO's static-filter parser,
// re-run the MV3 compatibility filter (stripLite) over the shipped lines and
// require ZERO drops — any line uBO Lite could not compile as a DNR rule or a
// domain-scoped CSS content script is a pipeline failure — require the shipped
// network-rule count (blocking + exceptions alike, since both consume uBO
// Lite's dynamic DNR rule budget) to fit the configured budget, require zero
// regex network rules, compile the network half through the real
// StaticNetworkFilteringEngine with zero dropped lines, probe sampled simple
// option-less rules against synthetic requests to prove they are live, and
// compile the cosmetic half through the vendored uBO cosmetic engine so nothing
// ships as dead CSS (all lite cosmetics must be domain-scoped declarative CSS).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import snfe from '@gorhill/ubo-core/js/static-net-filtering.js';
import { AstFilterParser } from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { parseSimpleRule } from '../src/network.js';
import { makeCosmeticEngine } from '../src/cosmetic-engine.js';
import { stripLite, isRegexRule } from '../src/lite.js';
import { loadConfig } from '../src/config.js';
import configFromCli from '../src/config.js';

const outputPath = resolve(process.argv[2] ?? 'output/StayBraveLite.txt');
const explicitBudget = process.argv[3] === undefined ? null : Number(process.argv[3]);
const probeLimit = Number(process.argv[4] ?? 1000);
const config = configFromCli({ config: 'lists.json' });
const budget = explicitBudget ?? config.lite?.network_budget ?? 25000;

const text = readFileSync(outputPath, 'utf8');
const lines = text.split('\n');
const rules = lines.filter(
  (l) => l !== '' && !l.startsWith('[') && !l.startsWith('!')
);

function kindOf(line) {
  const idx = Math.max(line.indexOf('#@#'), line.indexOf('##'), line.indexOf('#?#'));
  return idx === -1 ? 'network' : 'cosmetic';
}
const networkRuleCount = rules.reduce((n, l) => n + (kindOf(l) === 'network' ? 1 : 0), 0);
const cosmeticRuleCount = rules.length - networkRuleCount;
const regexCount = rules.filter((l) => isRegexRule(l)).length;

// 1. Parser gate: every line must parse clean, network errors and cosmetic
//    selector errors alike.
let failed = 0;
const byError = new Map();
let selectorInvalid = 0;
const parser = new AstFilterParser({ interactive: true, trustedSource: false });
for (const line of rules) {
  parser.result.error = undefined;
  parser.parse(line);
  const err = parser.astError;
  if (parser.hasError()) {
    failed += 1;
    byError.set(err, (byError.get(err) ?? 0) + 1);
    if (failed <= 5) console.error('  parser error:', line, 'astError=', err);
  }
  const selectorErr = parser.result.error;
  if (selectorErr !== undefined) {
    selectorInvalid += 1;
    if (selectorInvalid <= 5) {
      console.error('  selector compile error:', line, '->', selectorErr.split('\n')[0]);
    }
  }
}
if (failed > 0 || selectorInvalid > 0) {
  console.error(
    `parser: ${failed} network error(s) ${JSON.stringify(
      Object.fromEntries([...byError].map(([k, v]) => [k, v]))
    )}, ${selectorInvalid} selector error(s)`
  );
  process.exitCode = 1;
} else {
  console.log(`parser: ${rules.length} rules all clean`);
}

// 2. MV3 re-check: running stripLite over the shipped lines must drop nothing.
//    Any drop means the pipeline let an MV3-incompatible rule through.
const recheck = stripLite(rules);
const droppedTotal = rules.length - recheck.lines.length;
const drops = Object.fromEntries(
  Object.entries(recheck.stats).filter(([k, v]) => k !== 'total' && v > 0)
);
if (droppedTotal > 0) {
  console.error(
    `mv3 re-check: ${droppedTotal} shipped line(s) would be dropped by uBO Lite (${JSON.stringify(drops)})`
  );
  process.exitCode = 1;
} else {
  console.log(`mv3 re-check: ${rules.length} shipped lines, zero MV3-incompatible`);
}
if (regexCount > 0) {
  console.error(`mv3 re-check: ${regexCount} regex network rule(s) shipped`);
  process.exitCode = 1;
}

// 3. Budget gate: blocking + exception network rules both consume uBO Lite's
//    dynamic DNR rule budget, so the shipped network count must fit the budget.
console.log(
  `budget: ${networkRuleCount} network rules (${networkRuleCount - 0} incl. exceptions) vs budget ${budget}`
);
if (networkRuleCount > budget) {
  console.error(`budget: ${networkRuleCount} network rules exceed ${budget}`);
  process.exitCode = 1;
} else if (networkRuleCount > Math.floor(budget * 0.95)) {
  console.log(`budget: within ${budget} but above 95% use — consider raising the cap`);
} else {
  console.log(`budget: OK`);
}

// 4. Compile the network half through the real engine; uBO surfaces dropped
//    lines via events. Cosmetic lines are ignored by the SNFE.
const events = [];
const snfeProxy = await StaticNetFilteringEngine.create();
await snfeProxy.useLists([{ name: outputPath, raw: text }], { events });
if (events.length > 0) {
  console.error('SNFE dropped lines during compilation:');
  for (const ev of events.slice(0, 20)) console.error('  ', ev.text);
  process.exitCode = 1;
} else {
  console.log('SNFE compiled the full file with zero dropped lines');
}
const registeredUnits = snfe.getFilterCount();
const unitDelta = registeredUnits - networkRuleCount;
console.log(
  `engine registration: ${registeredUnits} units registered vs ${networkRuleCount} network lines ` +
    (unitDelta >= 0
      ? `(+${unitDelta} net units from $redirect / split options)`
      : `(${unitDelta} network rules did not register)`)
);
if (registeredUnits < networkRuleCount * 0.98) {
  console.error(`engine registered only ${registeredUnits} units for ${networkRuleCount} network lines`);
  process.exitCode = 1;
}

// 5. Dispatch-lane profile from the engine's own bucket histogram (reuses the
//    same classification verify.js reports for the classic build).
const ep = { hostname_dict: 0, origin_dict: 0, token_units: 0, token_1char: 0, token_2plus: 0, no_token: 0 };
{
  let entries = null;
  const origInfo = console.info;
  console.info = (x) => { entries = x; };
  snfe.bucketHistogram();
  console.info = origInfo;
  for (const h of entries ?? []) {
    if (h.token === '10000000') ep.hostname_dict += h.count;
    else if (h.token === '20000000' || h.token === '30000000' || h.token === '40000000') ep.origin_dict += h.count;
    else if (h.token === '50000000') ep.no_token += h.count;
    else if (h.token.length === 1) ep.token_1char += h.count;
    else ep.token_2plus += h.count;
  }
  ep.token_units = ep.token_1char + ep.token_2plus;
}
{
  const total = ep.hostname_dict + ep.origin_dict + ep.token_units + ep.no_token;
  const cheap = total - ep.no_token;
  console.log(
    `engine dispatch: ${total} network units -> ` +
      `${ep.hostname_dict} hostname-dict / ${ep.origin_dict} origin-dict / ` +
      `${ep.token_units} tokenized (${ep.token_2plus} >=2-char, ${ep.token_1char} 1-char) ` +
      `- ${cheap} on token/hash lanes (${((100 * cheap) / total).toFixed(3)}%), ` +
      `${ep.no_token} always-tested (NO_TOKEN_HASH)`
  );
}

// 6. Liveness probes: sampled simple option-less rules must all block a
//    synthetic request, otherwise the optimizer mis-dropped them.
const probed = [];
for (const line of rules) {
  if (probed.length >= probeLimit) break;
  const simple = parseSimpleRule(line);
  if (
    simple !== null &&
    !simple.host.startsWith('.') &&
    simple.host.includes('.')
  ) {
    probed.push(simple);
  }
}
let blockOk = 0;
let blockFail = 0;
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
    blockFail += 1;
    if (blockFail <= 5) console.error('  not blocking:', r.raw, '->', res);
  } else {
    blockOk += 1;
  }
}
console.log(`liveness probes: ${blockOk} blocked / ${blockFail} failed (of ${probed.length} probed)`);
if (blockFail > 0) process.exitCode = 1;

// 7. Cosmetic gate: compile every cosmetic line through the vendored uBO
//    cosmetic engine. All lite cosmetics are declarative and domain-scoped;
//    any rule the engine would drop under default settings is a pipeline bug.
const cosmeticEngineLines = rules.filter((l) => kindOf(l) === 'cosmetic');
const ce = await makeCosmeticEngine(cosmeticEngineLines, { name: outputPath });
console.log(
  `cosmetic engine: ${ce.units} units registered vs ${cosmeticEngineLines.length} cosmetic lines ` +
    `(${ce.accepted} accepted, ${ce.discarded} engine-dedup, ${ce.dropped.length} dropped)`
);
if (ce.dropped.length > 0) {
  console.error(`cosmetic engine: ${ce.dropped.length} cosmetic rule(s) would be dropped by default uBO settings`);
  for (const m of ce.dropped.slice(0, 5)) console.error('  ', m.text);
  process.exitCode = 1;
}

// 8. Cosmetic liveness probes: sampled domain-scoped hides must be returned by
//    the engine for a synthetic frame URL (the retrieve() path uBO runs).
let cosOk = 0;
let cosFail = 0;
{
  const collapseWS = (s) => {
    let out = '';
    let quote = null;
    let wasWS = false;
    for (const ch of s) {
      if (quote !== null) {
        out += ch;
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
        out += ch;
      } else if (/\s/.test(ch)) {
        wasWS = true;
      } else {
        if (wasWS) out += ' ';
        wasWS = false;
        out += ch;
      }
    }
    return out;
  };
  const norm = (s) =>
    collapseWS(s.trim())
      .replace(/,$/, '')
      .replace(/,(?=\S)/g, ', ')
      .replace(/\s*([>+~])\s*/g, ' $1 ')
      .replace(/'/g, '"');
  const qu = (s) => s.replace(/["']/g, '');
  const sl = (s) => s.replace(/\\(.)/g, '$1');
  const stride =
    cosmeticEngineLines.length > probeLimit
      ? Math.ceil(cosmeticEngineLines.length / probeLimit)
      : 1;
  for (let i = 0; i < cosmeticEngineLines.length && cosOk + cosFail < probeLimit; i += stride) {
    const line = cosmeticEngineLines[i];
    if (line.includes('#@#')) continue;
    const idx = line.indexOf('##');
    const hostPart = line.slice(0, idx);
    if (hostPart === '' || hostPart.startsWith('~')) continue;
    const hosts = hostPart.split(',');
    const selector = line.slice(idx + 2);
    if (selector === '') continue;
    let present = false;
    let probedAny = false;
    for (const rawHost of hosts) {
      const firstHost = rawHost.trim();
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(firstHost)) continue;
      probedAny = true;
      const out = ce.probe(firstHost, firstHost, `http://${firstHost}/`);
      const cssLines = (out.injectedCSS ?? '')
        .split('\n')
        .map((s) => norm(s));
      const procLines = (out.proceduralFilters ?? [])
        .concat(out.convertedProceduralFilters ?? [])
        .map((p) => {
          try {
            return norm(JSON.parse(p).raw);
          } catch {
            return null;
          }
        });
      const ref = norm(selector);
      let found = cssLines.includes(ref) || procLines.includes(ref);
      if (!found) found = cssLines.map(qu).includes(qu(ref)) || procLines.map(qu).includes(qu(ref));
      if (!found) found = cssLines.map(sl).includes(sl(ref)) || procLines.map(sl).includes(sl(ref));
      if (found) {
        present = true;
        break;
      }
    }
    // Wildcard/excluded host patterns (`2gis.*##…`, `~bad.net,good.net##…`)
    // have no probeable concrete host — skip, do not fail them.
    if (probedAny === false) continue;
    if (present) {
      cosOk += 1;
    } else {
      cosFail += 1;
      if (cosFail <= 5) console.error('  cosmetic not retrieved:', line);
    }
  }
}
console.log(
  `cosmetic liveness probes: ${cosOk} present / ${cosFail} missing (of ${cosOk + cosFail} probed)`
);
if (cosFail > 0) process.exitCode = 1;

console.log(
  `output: ${rules.length} rules (${networkRuleCount} network, ${cosmeticRuleCount} cosmetic)`
);
console.log(`exit: ${process.exitCode === 1 ? 'FAIL' : 'PASS'}`);