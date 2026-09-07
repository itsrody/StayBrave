// Independent gate before a build is committed: parse the final list 100%
// error-free with uBO's static-filter parser (network `astError` and cosmetic
// ExtSelectorCompiler errors alike), compile the whole file through
// the real StaticNetworkFilteringEngine (SNFE), and probe a sample of the
// simple option-less network rules with synthetic requests to prove they are
// live (nothing was over-staticized/dropped by the optimizer). Also reports
// how many network units the engine actually registers (getFilterCount, the
// same number uBO's dashboard "used" counter derives from), proves that
// supported modifier rules ($removeparam, $csp, $permissions, $uritransform)
// answer through the engine's modifier APIs, and derives the dispatch-lane
// profile straight from the engine's own bucket histogram (which of the
// onBeforeRequest lanes each network unit is stored on: hostname/just-origin
// dictionaries, tokenized patterns, or the always-tested NO_TOKEN_HASH lane).
// It also compiles the cosmetic half through the vendored uBO cosmetic engine
// (same parser + writer/reader uBO uses) and probes that sampled cosmetic
// rules still yield selectors the engine would inject, so nothing ships dead.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import snfe from '@gorhill/ubo-core/js/static-net-filtering.js';
import { AstFilterParser } from '@gorhill/ubo-core/js/static-filtering-parser.js';
import { parseSimpleRule } from '../src/network.js';
import { makeCosmeticEngine } from '../src/cosmetic-engine.js';
import { parse as parseHost } from 'tldts';
import {
  mirrorTokenFromPattern,
  mirrorTokenFromQuerypruneValue,
  mirrorTokenFromRegex,
} from '../src/tokens.js';
import {
  NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM,
} from '@gorhill/ubo-core/js/static-filtering-parser.js';

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
let selectorInvalid = 0;
const parser = new AstFilterParser({ interactive: true, trustedSource: false });
const probed = [];
const modifierProbes = { removeparam: [], csp: [], permissions: [], uritransform: [] };
// Rule-level lint for the NO_TOKEN_HASH (always-tested) lane. The authoritative
// dispatch profile is derived from the engine's own bucket histogram after
// compilation; this lint only classifies, per rule, whether an always-tested
// rule is inherent policy (pattern `*`, regex without a derivable token, or any
// scoped option) or a rewritable defect (bare tokenless pattern like `*xyz*`).
const ruleLint = { policy: 0, fixable: 0 };
// Cosmetic lines (`##` / `#@#`, never `#?#` strong / scriptlet / HTML) fed to
// the vendored cosmetic engine after the network sections.
const cosmeticEngineLines = [];

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

// Mirror of FilterCompiler#isJustOrigin(): true when the rule is an origin
// dict rule (ANY_TOKEN_HASH / ANY_HTTP_TOKEN_HASH / ANY_HTTPS_TOKEN_HASH lane),
// i.e. optionUnitBits === FROM_BIT, pattern `*` or a bare `http[s*]:` with a
// start anchor, and the domain list contains no `~`/`/`.
function isJustOriginRule(parser, line) {
  const opts = line.split('$').slice(1).join('$');
  if (opts === '') return false;
  const domainValues = [];
  for (const seg of opts.split(',')) {
    if (seg === '') continue;
    const m = /^(?:domain|from)(?:=(.*))?$/.exec(seg);
    if (m === null) return false;
    if (m[1] !== undefined) domainValues.push(m[1]);
  }
  if (domainValues.length === 0) return false;
  if (/[/~]/.test(domainValues.join('|'))) return false;
  const pattern = parser.getNetPattern();
  if (pattern === '*') return true;
  if (parser.isLeftAnchored() === false) return false;
  return /^(?:http[s*]?:(?:\/\/)?)$/.test(pattern);
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
  parser.result.error = undefined;
  parser.parse(line);
  const err = parser.astError;
  const hasErr = parser.hasError();
  if (hasErr) {
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
  if (parser.isNetworkFilter()) {
    // Always-tested (NO_TOKEN_HASH lane) rule lint.
    //  - regex patterns: policy when no token can be derived from literals.
    //  - pattern `*`: policy unless removeparam (value token) or just-origin.
    //  - plain patterns: policy when scoped (any option), fixable when a bare
    //    tokenless pattern such as `*xyz*` (rewritable, no cost-free reason).
    // Hostname-anchored rules are never touched here: they ride the hostname
    // dict lane unless they carry option-units, which still keep a hostname
    // token — so they cannot be always-tested.
    if (parser.isRegexPattern()) {
      if (mirrorTokenFromRegex(parser.getNetPattern()) === null) {
        ruleLint.policy += 1;
      }
    } else if (parser.isAnyPattern()) {
      const rp = parser.getNetOptionValue(NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM);
      if ([...parser.getNodeTypes()].includes(NODE_TYPE_NET_OPTION_NAME_REMOVEPARAM)) {
        if (mirrorTokenFromQuerypruneValue(rp) === null) ruleLint.policy += 1;
      } else if (isJustOriginRule(parser, line) === false) {
        ruleLint.policy += 1;
      }
    } else {
      const t = mirrorTokenFromPattern(parser.getNetPattern());
      if (t === null) {
        if (parser.hasOptions()) ruleLint.policy += 1;
        else ruleLint.fixable += 1;
      }
    }
  } else if (parser.isCosmeticFilter() && line.includes('#?#') === false) {
    cosmeticEngineLines.push(line);
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
if (selectorInvalid > 0) {
  console.error(`source parser: ${selectorInvalid} cosmetic selectors fail to compile`);
  process.exitCode = 1;
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

// Dispatch-lane profile straight from the engine: every network unit sits in a
// realm bucket keyed by token hash, and bucketHistogram() enumerates them.
//  - DOT_TOKEN_HASH + FilterHostnameDict: hostname dictionary (cheap)
//  - ANY/ANY_HTTPS/ANY_HTTP_TOKEN_HASH + FilterJustOrigin*: origin dict (cheap)
//  - every other token hash: tokenized pattern (cheap, one bucket per token)
//  - NO_TOKEN_HASH: always tested on every request (never on a token)
const engineProfile = { hostname_dict: 0, origin_dict: 0, token_units: 0, token_1char: 0, token_2plus: 0, no_token: 0 };
{
  let entries = null;
  const origInfo = console.info;
  console.info = (x) => { entries = x; };
  snfe.bucketHistogram();
  console.info = origInfo;
  for (const h of entries ?? []) {
    if (h.token === '10000000') engineProfile.hostname_dict += h.count;
    else if (h.token === '20000000' || h.token === '30000000' || h.token === '40000000') engineProfile.origin_dict += h.count;
    else if (h.token === '50000000') engineProfile.no_token += h.count;
    else if (h.token.length === 1) engineProfile.token_1char += h.count;
    else engineProfile.token_2plus += h.count;
  }
  engineProfile.token_units = engineProfile.token_1char + engineProfile.token_2plus;
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

// Cosmetic engine gate: compile every cosmetic line (`##`, `#@#`) through the
// vendored uBO cosmetic engine using the exact parser + writer/reader uBO's
// filterset uses. With the stock allowGenericProceduralFilters=false, generic
// procedural rules (`##div:has(…)`) are dropped at list load; the build pass
// removes them, so any that reach this gate are a pipeline failure.
const ce = await makeCosmeticEngine(cosmeticEngineLines, {
  name: outputPath,
});
console.log(
  `cosmetic engine: ${ce.units} units registered vs ${cosmeticEngineLines.length} cosmetic lines ` +
  `(${ce.accepted} accepted, ${ce.discarded} engine-dedup, ${ce.dropped.length} dropped)`
);
if (ce.dropped.length > 0) {
  console.error(
    `cosmetic engine: ${ce.dropped.length} cosmetic rule(s) would be dropped by stock uBO ` +
      `(generic procedural filters with default allowGenericProceduralFilters=false)`
  );
  for (const m of ce.dropped.slice(0, 5)) console.error('  ', m.text);
  process.exitCode = 1;
}

// Cosmetic liveness probes: sample host-anchored hides and prove the engine
// returns the rule for a synthetic frame URL (the retrieve() path uBO runs at
// webNavigation.onCommitted). Declarative selectors must appear in the
// injected-CSS selector set; procedural selectors must come back as a JSON
// task list whose `raw` equals the rule's selector. A missing selector means
// the optimizer dropped/reworded it and it no longer runs.
let cosOk = 0;
let cosFail = 0;
{
  // The engine may normalize whitespace (e.g. a space after commas inside
  // :not()), and it reserializes attribute strings with double quotes (so an
  // unquoted/single-quoted source rule comes back as double-quoted CSS), so
  // compare both sides through the same normalization: collapse whitespace
  // runs outside quoted strings, swap quote characters, and strip the comma
  // uBO appends between selector set members. A specific rule comes back one
  // way: declarative selectors land on their own (trimmed, comma-lipped) line
  // of injectedCSS (incl. :style() converted to a CSS rule),
  // procedural/pseudo selectors land as a JSON task whose `raw` is the rule
  // selector — route by what the engine actually returned, not by a local
  // classification that may disagree with the engine's.
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
      .replace(/'/g, '"'); // quote chars are interchangeable in CSS strings
  // uBO reserializes attribute strings with double quotes (`[class*=x]` comes
  // back as `[class*="x"]`), which is CSS-value-identical only when compared
  // without the quotes, and a scoped exception may legitimately withdraw a
  // hide on exactly one host of a multi-host rule. So a probe counts as
  // missing only when no positive host of the rule's scope delivers the
  // selector, and a quotes-stripped retry is made before declaring it gone.
  const qu = (s) => s.replace(/["']/g, '');
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
      const domain = parseHost(firstHost, { allowPrivateDomains: true }).domain ?? firstHost;
      const out = ce.probe(firstHost, domain, `http://${firstHost}/`);
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
      let found =
        cssLines.includes(ref) ||
        procLines.includes(ref);
      if (!found) {
        found =
          cssLines.map((s) => qu(s)).includes(qu(ref)) ||
          procLines.map((s) => qu(s)).includes(qu(ref));
      }
      if (found) {
        present = true;
        break;
      }
    }
    // Wildcard/excluded host patterns (`amazon.*##…`, `~bad.net,good.net##…`)
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

const kinds2 = { network: kindCounts.network, cosmetic: kindCounts.cosmetic };
console.log(
  `output: ${rules.length} rules (${kinds2.network} network, ${kinds2.cosmetic} cosmetic)`
);

const ep = engineProfile;
const epTotal =
  ep.hostname_dict + ep.origin_dict + ep.token_units + ep.no_token;
const epCheap = epTotal - ep.no_token;
const epPct = (100 * epCheap) / epTotal;
console.log(
  `engine dispatch: ${epTotal} network units → ` +
  `${ep.hostname_dict} hostname-dict / ${ep.origin_dict} origin-dict / ` +
  `${ep.token_units} tokenized (${ep.token_2plus} ≥2-char, ${ep.token_1char} 1-char) ` +
  `— ${epCheap} on token/hash lanes (${epPct.toFixed(3)}%), ` +
  `${ep.no_token} always-tested (NO_TOKEN_HASH)`
);
const lintPolicy = ruleLint.policy;
const lintFixable = ruleLint.fixable;
console.log(
  `rule lint: ${lintPolicy + lintFixable} network rule(s) reach NO_TOKEN_HASH ` +
  `(mirror: ${lintPolicy} inherent policy, ${lintFixable} rewritable defect)`
);
if (lintFixable > 0) {
  console.error(
    `rule lint: ${lintFixable} network rule(s) are always-tested yet rewritable ` +
      `(bare tokenless pattern, no scoping option) — rewrite them so a token can be derived`
  );
  process.exitCode = 1;
}
console.log(`exit: ${process.exitCode === 1 ? 'FAIL' : 'PASS'}`);
