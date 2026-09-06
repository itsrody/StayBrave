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
  const idx = body.lastIndexOf('$');
  if (idx === -1) return line;
  const pattern = body.slice(0, idx);
  if (pattern.includes('#')) return line;

  const parts = body.slice(idx + 1).split(',');
  let changed = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    let name = part;
    if (name.startsWith('~')) name = name.slice(1);
    const eq = name.indexOf('=');
    if (eq !== -1) name = name.slice(0, eq);
    const canon = CANONICAL.get(name);
    if (canon !== undefined && canon !== name) {
      changed = true;
      const neg = part.startsWith('~') ? '~' : '';
      parts[i] = neg + canon + (eq === -1 ? '' : part.slice(eq));
    }
  }
  if (!changed) return line;
  return line.slice(0, offset) + pattern + '$' + parts.join(',');
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