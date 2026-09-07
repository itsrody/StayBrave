// Engine-truthful efficiency analyzer.
//
// Mirrors uBO's StaticNetFilteringEngine dispatch model (see
// static-net-filtering.js `FilterCompiler`/`freeze`) so the cost classes are
// exactly the three ways a network rule can be stored:
//
//   tokened    — bucket keyed by a real URL token (the 2+ char run derived
//                from the filter pattern, e.g. the hostname of `||host^`).
//                The rule is only visited for requests whose host/path
//                contains that token — the cheapest path, and the one Firefox
//                executes in WebAssembly.
//   justOrigin — `*`/`http(s)://` patterns whose only option is `domain=`:
//                compiled into FilterJustOrigin units behind the ANY/HTTP/HTTPS
//                token hashes. Visited on every (scheme-compatible) request,
//                but the request domain is trie-checked — cheaper than a full
//                pattern scan.
//   catchall   — NO_TOKEN bucket: the pattern yields no durable 2+ char run
//                (`*$script`, `$1p`-only patterns, …). Visited on every
//                request and every unit is fully evaluated.
//
// Cosmetic rules are graded by lookup channel: simple class/id and
// hostname-hide are cheap CSS/hostname lookups (green), token-led and
// hostname-unhide are middle (amber), and generic-misc / procedural are
// visited for every document (red).
//
// Firefox-exclusive families are classified separately: HTML filters (`##^`)
// run per-document through webRequest.filterResponseData, response-header
// filters (`##^responseheader`) modify onHeadersReceived, and scriptlets are
// injected per element. `$ipaddress`/`$cname` rules decide before the
// connection (DNS stage) and are cheap on every path.

import { classifyChannel } from './cosmetic.js';

const RUN = /[0-9A-Za-z%]{2,}/g;

// True if the pattern carries a durable 2+ char run that uBO's matcher can use
// as a token bucket key. Mirrors FilterCompiler.extractTokenFromPattern: runs
// immediately adjacent to a `*` are disqualified.
function hasDurableRun(pattern) {
  RUN.lastIndex = 0;
  let m;
  while ((m = RUN.exec(pattern)) !== null) {
    const bef = m.index === 0 ? '' : pattern[m.index - 1];
    const aft = m.index + m[0].length < pattern.length ? pattern[m.index + m[0].length] : '';
    if (bef !== '*' && aft !== '*') return true;
  }
  return false;
}

// Mirror of FilterCompiler.isJustOrigin(): option bag must be exactly the
// `domain=`/`from=` option and the pattern must be `*` or a left-anchored
// `http(s)://` form.
function isJustOrigin(pattern, opts) {
  if (opts.length === 0) return false;
  const onlyFrom = opts.every((o) => {
    const t = o.trim();
    if (t.startsWith('~')) return false;
    const eq = t.indexOf('=');
    const name = eq === -1 ? t : t.slice(0, eq);
    return name === 'domain' || name === 'from';
  });
  if (!onlyFrom) return false;
  if (pattern === '*') return true;
  if (/^(?:\|)?https?:(\/\/)?$/.test(pattern)) return true;
  return false;
}

function splitOptions(line) {
  const body = line.startsWith('@@') ? line.slice(2) : line;
  const idx = body.lastIndexOf('$');
  if (idx === -1) return { pattern: body, opts: [] };
  return { pattern: body.slice(0, idx), opts: body.slice(idx + 1).split(',') };
}

export const Channel = {
  NetworkTokened: 0,
  NetworkJustOrigin: 1,
  NetworkCatchall: 2,
  CosmeticGreen: 3,
  CosmeticAmber: 4,
  CosmeticRed: 5,
  HtmlFilter: 6,
  Responseheader: 7,
  Scriptlet: 8,
};

export function classifyNetwork(line) {
  const { pattern, opts } = splitOptions(line);
  // An empty pattern compiles to the same just-origin unit as `*` (SNFE
  // normalizes pattern-less rules to `*`), so classify them together.
  const effective = pattern === '' ? '*' : pattern;
  if (effective === '*') {
    if (isJustOrigin(effective, opts)) return Channel.NetworkJustOrigin;
    return Channel.NetworkCatchall;
  }
  if (effective.includes('#')) return Channel.NetworkCatchall;
  if (
    (effective.startsWith('|http://') || effective.startsWith('|https://')) &&
    isJustOrigin(effective, opts)
  ) {
    return Channel.NetworkJustOrigin;
  }
  return hasDurableRun(effective) ? Channel.NetworkTokened : Channel.NetworkCatchall;
}

function cosmeticChannel(line) {
  const c = classifyChannel(line);
  if (c === 0 || c === 3) return Channel.CosmeticGreen;
  if (c === 1 || c === 4) return Channel.CosmeticAmber;
  if (c === 2 || c === 5) return Channel.CosmeticRed;
  return null;
}

// Per-line cost class for one filter line.
export function classifyRule(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('!') || trimmed.startsWith('[')) {
    return null;
  }
  if (line.includes('#+js(')) return Channel.Scriptlet;
  if (line.includes('^responseheader')) return Channel.Responseheader;
  if (
    (line.includes('##^') || line.includes('#@#^')) &&
    !line.includes('^responseheader')
  ) {
    return Channel.HtmlFilter;
  }
  if (line.includes('##') || line.includes('#?#') || line.includes('#@#')) {
    return cosmeticChannel(line);
  }
  return classifyNetwork(line);
}

// Grade helper: 0..1 score into a letter band.
export function gradeOf(score) {
  if (score >= 0.995) return 'A+';
  if (score >= 0.98) return 'A';
  if (score >= 0.95) return 'A-';
  if (score >= 0.9) return 'B+';
  if (score >= 0.85) return 'B';
  if (score >= 0.8) return 'B-';
  if (score >= 0.7) return 'C+';
  if (score >= 0.6) return 'C';
  if (score >= 0.5) return 'D';
  return 'F';
}

const score = (green, amber, red) => {
  const total = green + amber + red;
  return total === 0 ? 1 : (green + amber * 0.5) / total;
};

// Aggregate cost-class counts + grades for the final rule set.
export function analyzeEfficiency(lines, { catchallSamples = 8 } = {}) {
  const cls = {
    network: { tokened: 0, justOrigin: 0, catchall: 0 },
    cosmetic: { green: 0, amber: 0, red: 0 },
    htmlFilters: 0,
    responseheaders: 0,
    scriptlets: 0,
  };
  const catchallExamples = [];
  for (const line of lines) {
    switch (classifyRule(line)) {
      case Channel.NetworkTokened:
        cls.network.tokened += 1;
        break;
      case Channel.NetworkJustOrigin:
        cls.network.justOrigin += 1;
        break;
      case Channel.NetworkCatchall:
        cls.network.catchall += 1;
        if (catchallExamples.length < catchallSamples) catchallExamples.push(line);
        break;
      case Channel.CosmeticGreen:
        cls.cosmetic.green += 1;
        break;
      case Channel.CosmeticAmber:
        cls.cosmetic.amber += 1;
        break;
      case Channel.CosmeticRed:
        cls.cosmetic.red += 1;
        break;
      case Channel.HtmlFilter:
        cls.htmlFilters += 1;
        break;
      case Channel.Responseheader:
        cls.responseheaders += 1;
        break;
      case Channel.Scriptlet:
        cls.scriptlets += 1;
        break;
      default:
        break;
    }
  }

  const netScore = score(cls.network.tokened, cls.network.justOrigin, cls.network.catchall);
  const cosScore = score(cls.cosmetic.green, cls.cosmetic.amber, cls.cosmetic.red);

  return {
    network: { ...cls.network, score: netScore, grade: gradeOf(netScore) },
    cosmetic: { ...cls.cosmetic, score: cosScore, grade: gradeOf(cosScore) },
    html_filters: cls.htmlFilters,
    responseheaders: cls.responseheaders,
    scriptlets: cls.scriptlets,
    catchall_examples: catchallExamples,
  };
}