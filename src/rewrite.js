// Semantics-preserving rewrite of network filter option spellings to uBO's
// canonical long-form names.
//
// uBO's parser accepts several spellings for the same option
// (`netOptionTokenDescriptors` in static-filtering-parser.js): `1p` and
// `first-party` map to the same option node type, as do `xhr` /
// `xmlhttprequest`, `queryprune` / `removeparam`, `rewrite` / `redirect`, …
// Because the merged list is deduplicated on the raw string, a rule spelled
// `$1p` and an identical rule spelled `$first-party` currently survive as two
// rules. Rewriting every spelling to the canonical name lets those true
// duplicates collapse and makes the token-bucket / efficiency statistics
// measure exactly what uBO's engine sees.
//
// The rewrite is provably semantics-preserving: each mapping below is a parser
// synonym — the pair resolves to the same option node type, so the compiled
// engine bits (type/party/modifier units) are identical. Lines that do not
// change are returned byte-for-byte. Every rewritten line is still parsed by
// uBO's engine in the Verify stage, which certifies the rewrite for a second
// time.
//
// `domain=`/`from=` and `to=` are deliberately left as written: they are in
// common use in every spelling and are not part of this rename set.
//
// Two further strict-grammar normalizations ride on the same parse: a
// pattern-less rule (`$domain=…`) is rewritten to the `*`-pattern spelling its
// compiled unit already has, and the option tokens are sorted in a canonical
// order with exact-duplicate tokens collapsed. Both are engine-equivalent
// (SNFE compiles `$domain=` and `*$domain=` to one just-origin unit, treats the
// option set as order-independent, and folds identical tokens) and they make
// the shipped text byte-for-byte the strict grammar uBO stores.

const CANONICAL = new Map([
  ['1p', 'first-party'],
  ['3p', 'third-party'],
  ['xhr', 'xmlhttprequest'],
  ['beacon', 'ping'],
  ['css', 'stylesheet'],
  ['doc', 'document'],
  ['ehide', 'elemhide'],
  ['frame', 'subdocument'],
  ['ghide', 'generichide'],
  ['queryprune', 'removeparam'],
  ['rewrite', 'redirect'],
  ['shide', 'specifichide'],
]);

const COSMETIC_MARKERS = /##|#\?#|#@#/;

// Canonical order for network option tokens (uBO treats the option set as
// order-independent — SNFE registers `$1p,xmlhttprequest` and
// `$xmlhttprequest,1p` as the same unit — so a fixed sorted order yields the
// strict-grammar spelling for every rule and lets twins that differ only in
// option order collapse in the dedup pass).
function canonicalOptOrder(a, b) {
  const prio = (t) => (t === 'domain' || t === 'from' ? 1 : t === 'important' || t === 'badfilter' ? 2 : 0);
  const na = a.replace(/^~/, '');
  const nb = b.replace(/^~/, '');
  const ea = na.indexOf('=') === -1 ? na : na.slice(0, na.indexOf('='));
  const eb = nb.indexOf('=') === -1 ? nb : nb.slice(0, nb.indexOf('='));
  return prio(ea) - prio(eb) || ea.localeCompare(eb) || na.localeCompare(nb);
}

// Split a network option list on `,`, honoring backslash-escaped commas inside
// option values. uBO's parser lets a `removeparam`/`redirect`/`replace` regex
// carry an escaped `\,` (e.g. `$removeparam=/^__s=[A-Za-z0-9]{6\,}/`), so a
// naive `split(',')` would cut the value mid-regex and reordering the shards
// would corrupt the rule.
function splitOptionTokens(s) {
  const parts = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[i + 1];
      i += 1;
      continue;
    }
    if (ch === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

// Rewrite the network option tokens of a single filter line. Returns the input
// unchanged unless at least one option token was renamed. Only the matched
// token is replaced; every other byte (pattern, spacing, option values,
// unknown tokens) is preserved exactly, so the reconstruction is safe even for
// values that smuggle in `$` or `,`.
export function canonicalizeNetOptions(line) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('!') || trimmed.startsWith('[')) {
    return line;
  }
  if (COSMETIC_MARKERS.test(line)) return line;

  let body = line;
  let offset = 0;
  if (body.startsWith('@@')) {
    offset = 2;
    body = body.slice(2);
  }
  const idx = body.startsWith('$') ? 0 : body.lastIndexOf('$');
  if (idx === -1) return line;
  let pattern = body.slice(0, idx);
  if (pattern.includes('#')) return line;

// A pattern-less rule (`$domain=example.com`) is engine-identical to its
// `*`-pattern spelling (SNFE compiles both into the same just-origin unit,
// and the engine is the authority the shipped file is verified against).
// Normalizing to `*` gives every rule an explicit pattern. (The option
// delimiter of a pattern-less rule is its leading `$` — a `$` inside a
// `removeparam=`/`redirect=` regex value is literal and must not confuse it.)
const patternChanged = pattern === '';
  if (patternChanged) pattern = '*';

  const parts = splitOptionTokens(body.slice(idx + 1));
  let renamed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    let name = part;
    if (name.startsWith('~')) name = name.slice(1);
    const eq = name.indexOf('=');
    if (eq !== -1) name = name.slice(0, eq);
    const canon = CANONICAL.get(name);
    if (canon !== undefined && canon !== name) {
      renamed = true;
      const neg = part.startsWith('~') ? '~' : '';
      parts[i] = neg + canon + (eq === -1 ? '' : part.slice(eq));
    }
  }

  // Strict grammar: sort the option tokens in canonical order and collapse
  // EXACT duplicate tokens only. SNFE folds identical type/party/repeated
  // tokens into one mask and treats repeated `domain=`/`from=` as a union, so
  // dropping a byte-identical token (or reordering any two tokens) never
  // changes the compiled unit — but reordering alone lets spellings of the
  // same rule that differ in option order deduplicate as one text line.
  const sorted = [...new Set(parts)].sort(canonicalOptOrder);
  const changed =
    patternChanged || renamed || sorted.join(',') !== parts.join(',');
  if (!changed) return line;
  return line.slice(0, offset) + pattern + '$' + sorted.join(',');
}

// Rewrite every network line in a merged rule set; returns the new lines and
// the number of lines that changed.
export function canonicalizeRules(lines) {
  let rewritten = 0;
  const out = [];
  for (const line of lines) {
    const next = canonicalizeNetOptions(line);
    if (next !== line) rewritten += 1;
    out.push(next);
  }
  return [out, rewritten];
}