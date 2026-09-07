// The real uBO cosmetic filtering engine, vendored from uBlock master
// (see vendor/ubo/README) and driven exactly the way uBO's own filterset does:
//
//   1. compile:  AstFilterParser + CosmeticFilteringEngine#compile(parser, writer)
//   2. serialize: CompiledListWriter → CompiledListReader
//   3. load:      CosmeticFilteringEngine#fromCompiledContent(reader)
//   4. retrieve:  CosmeticFilteringEngine#retrieveSpecificSelectors for a
//                 synthetic frame URL (never injecting into a tab).
//
// Two verdicts fall out of the engine itself, both faithful to stock uBO:
//   - units registered (getFilterCount) after dedup, and
//   - the rules the engine *drops* at compile time and surfaces through
//     logger.writeOne() — with the stock hidden setting
//     allowGenericProceduralFilters=false, every generic procedural cosmetic
//     filter (`##div:has(…)` with no host) is one of them.
// Any rule the engine drops never executes in a default Firefox uBO, so the
// build pipeline removes them and verify fails on any that remain.

import { AstFilterParser } from '@gorhill/ubo-core/js/static-filtering-parser.js';
import {
  CompiledListWriter,
  CompiledListReader,
} from '@gorhill/ubo-core/js/static-filtering-io.js';
import { takeLoggedMessages } from '../vendor/ubo/logger.js';
import { splitCosmetic, registrableDomain } from './cosmetic.js';

// vAPI is referenced at CosmeticFilteringEngine construction
// (vAPI.defer.create) and at retrieval (vAPI.tabs.insertCSS). The probe path
// always passes `dontInject:true` and no `tabId`, so the tabs hook never
// fires; the defer timer is a no-op so nothing schedules.
function ensureVAPI() {
  if (globalThis.vAPI !== undefined) return;
  globalThis.vAPI = {
    defer: {
      create: () => ({
        on() {},
        off() {},
        onidle() {},
        ongoing() {
          return false;
        },
      }),
    },
    tabs: { insertCSS() {} },
  };
}

let enginePromise;

function loadEngine() {
  if (enginePromise === undefined) {
    ensureVAPI();
    enginePromise = import('../vendor/ubo/cosmetic-filtering.js').then(
      (m) => m.default
    );
  }
  return enginePromise;
}

export function isCosmeticLine(line) {
  return (line.includes('##') || line.includes('#@#')) && !line.includes('#?#');
}

// Compile every cosmetic line (##/##@# — never #?# strong, scriptlets or HTML
// filters, which uBO routes to other engines) and load the engine. Returns
// the engine plus what the compile phase concluded.
export async function makeCosmeticEngine(
  lines,
  { name = 'staybrave', parser } = {}
) {
  const engine = await loadEngine();
  if (parser === undefined) {
    parser = new AstFilterParser({ interactive: true, trustedSource: false });
  }
  takeLoggedMessages();
  engine.reset();
  engine.freeze();

  const writer = new CompiledListWriter();
  writer.properties.set('name', name);

  let compiled = 0;
  for (const line of lines) {
    if (isCosmeticLine(line) === false) continue;
    parser.parse(line);
    if (parser.isCosmeticFilter() === false) continue;
    engine.compile(parser, writer);
    compiled += 1;
  }

  const dropped = takeLoggedMessages();
  const reader = new CompiledListReader(writer.toString());
  engine.fromCompiledContent(reader, {});

  return {
    engine,
    compiled,
    dropped,
    accepted: engine.acceptedCount,
    discarded: engine.discardedCount,
    units: engine.getFilterCount(),
    // host-scoped hide/exception units vs generic (lowly+highly) units, read
    // from the engine's own dump() output.
    probe(hostname, domain, url) {
      return engine.retrieveSpecificSelectors(
        { hostname, domain, url },
        { noGenericCosmeticFiltering: true, noSpecificCosmeticFiltering: false, dontInject: true }
      );
    },
  };
}

// The rules stock uBO would drop at list load. Used by the build pipeline to
// remove dead weight from the output before it ships.  Stock uBO drops
// generic procedural filters with the default allowGenericProceduralFilters,
// and logs `Invalid generic cosmetic filter in <list>: ##<selector>`. A rule
// is generic-equivalent when it has no host or only ~negated hosts, so the
// dropped message (which carries only the selector) maps back to full rule
// lines of that shape — removing exactly what the engine itself discards.
export async function detectDroppedCosmetics(
  lines,
  { name = 'staybrave', parser } = {}
) {
  const { dropped } = await makeCosmeticEngine(lines, { name, parser });
  const byMessage = new Map();
  for (const line of lines) {
    if (isCosmeticLine(line) === false) continue;
    const exc = line.includes('#@#');
    const idx = exc ? line.indexOf('#@#') : line.indexOf('##');
    const host = line.slice(0, idx);
    if (host !== '' && host.split(',').every((h) => h.startsWith('~')) === false) {
      continue;
    }
    const sel = line.slice(idx + (exc ? 3 : 2));
    const form = `${exc ? '#@#' : '##'}${sel}`;
    if (byMessage.has(form) === false) byMessage.set(form, line);
  }
  const out = new Map();
  for (const d of dropped) {
    const i = d.text.indexOf('##');
    if (i === -1) continue;
    const form = d.text.slice(i);
    if (byMessage.has(form)) out.set(byMessage.get(form), d.text);
  }
  return out;
}

// Authoritative evidence gate for the cosmetic A/C dead-hide candidates
// (`deadHidesByException`): a same-selector exception-withdrawing a hide across
// its whole scope is only certified when uBO's own cosmetic engine, with every
// rule still present, refuses to deliver that selector at every positive host
// of the hide's scope. Removing such a hide cannot change delivery — the
// engine already suppressed it.
export async function certifyCosmeticDeadHides(
  candidateLines,
  allLines,
  { name = 'staybrave' } = {}
) {
  const { probe } = await makeCosmeticEngine(allLines, { name });
  const certified = [];
  for (const line of candidateLines) {
    const parsed = splitCosmetic(line);
    if (parsed === null || parsed.host === '' || parsed.sep !== '##') continue;
    let covered = true;
    for (const part of parsed.host.split(',')) {
      const h = part.trim().toLowerCase();
      if (
        h === '' ||
        h.startsWith('~') ||
        h.includes('*') ||
        /[^0-9a-zA-Z.-]/.test(h)
      ) {
        covered = false;
        break;
      }
      const domain = registrableDomain(h);
      const out = probe(h, domain ?? h, `http://${h}/`);
      const injected = (out.injectedCSS ?? '')
        .split('\n')
        .map((s) => s.trim().replace(/,$/, ''));
      if (injected.includes(parsed.selector)) {
        covered = false;
        break;
      }
    }
    if (covered) certified.push(line);
  }
  return certified;
}