// Mirror of uBO's per-network-filter token derivation
// (`FilterCompiler#makeToken` in the pinned static-net-filtering.js) so an
// output file's onBeforeRequest cost can be estimated without reaching into
// engine internals.
//
// On Firefox uBO blocks every request synchronously in
// `webRequest.onBeforeRequest`. The engine dispatches a URL through lanes:
//   - pure hostname dictionary -- the DOT_TOKEN_HASH lane, probed without
//     tokenizing the URL at all. Any hostname-anchored pattern rides it, even
//     with type/party-only options (`||host^$image`, `||host^$3p`) because
//     those options never set `optionUnitBits`;
//   - just-origin dictionary -- the ANY_TOKEN_HASH / ANY_HTTPS / ANY_HTTP
//     lanes (`FilterJustOrigin`): `*$domain=…` and `|http(s|*)://$domain=…`
//     store one entry per `domain=` value;
//   - tokenized patterns -- the URL is tokenized once and only filters whose
//     extracted token is present in the URL are evaluated.
// A rule's token is its lowest-"badness" run of [%0-9A-Za-z]+ (cap 7 chars),
// where badness is the token's occurrence across 200K+ benchmark URLs. Tokens
// in the BAD_TOKENS histogram -- or a single char -- are the expensive ones:
// they are present in many URLs, so their rule is tested on many requests.
// A rule with no derivable token (e.g. `*ads*`, whose run is abutted by `*`
// on both sides) is the engine's worst case: it is matched against every
// request of its type (NO_TOKEN_HASH lane) unless it is origin-scoped policy
// (`$csp=` / `$permissions=` / `$denyallow=` / `$popup` with `$domain`), which
// uBO natively tests per request and cannot be rewritten without changing
// semantics.
//
// These mirrors feed examples/verify.js; the authoritative dispatch profile
// there is derived from the engine's own bucketHistogram() -- the mirrors only
// decide whether an always-tested rule is inherent policy or a rewritable
// defect.

export const MAX_TOKEN_LENGTH = 7;

// Collated from uBO's "miss" histogram over 200K+ benchmark URLs
// (static-net-filtering.js `badTokens`). Parity with the pinned package is
// asserted by test/tokens.test.js by re-extracting the list from the source;
// when ubo-core bumps, the test fails loudly and this map must follow the
// engine.
export const BAD_TOKENS = new Map([
  [ 'https', 123617 ],
  [ 'com', 76987 ],
  [ 'js', 43620 ],
  [ 'www', 33129 ],
  [ 'jpg', 32221 ],
  [ 'images', 31812 ],
  [ 'css', 19715 ],
  [ 'png', 19140 ],
  [ 'static', 15724 ],
  [ 'net', 15239 ],
  [ 'de', 13155 ],
  [ 'img', 11109 ],
  [ 'assets', 10746 ],
  [ 'min', 7807 ],
  [ 'cdn', 7568 ],
  [ 'content', 6900 ],
  [ 'wp', 6444 ],
  [ 'fonts', 6095 ],
  [ 'svg', 5976 ],
  [ 'http', 5813 ],
  [ 'ssl', 5735 ],
  [ 'amazon', 5440 ],
  [ 'ru', 5427 ],
  [ 'fr', 5199 ],
  [ 'facebook', 5178 ],
  [ 'en', 5146 ],
  [ 'image', 5028 ],
  [ 'html', 4837 ],
  [ 'media', 4833 ],
  [ 'co', 4783 ],
  [ 'php', 3972 ],
  [ '2019', 3943 ],
  [ 'org', 3924 ],
  [ 'jquery', 3531 ],
  [ '02', 3438 ],
  [ 'api', 3382 ],
  [ 'gif', 3350 ],
  [ 'eu', 3322 ],
  [ 'prod', 3289 ],
  [ 'woff2', 3200 ],
  [ 'logo', 3194 ],
  [ 'themes', 3107 ],
  [ 'icon', 3048 ],
  [ 'google', 3026 ],
  [ 'v1', 3019 ],
  [ 'uploads', 2963 ],
  [ 'googleapis', 2860 ],
  [ 'v3', 2816 ],
  [ 'tv', 2762 ],
  [ 'icons', 2748 ],
  [ 'core', 2601 ],
  [ 'gstatic', 2581 ],
  [ 'ac', 2509 ],
  [ 'utag', 2466 ],
  [ 'id', 2459 ],
  [ 'ver', 2448 ],
  [ 'rsrc', 2387 ],
  [ 'files', 2361 ],
  [ 'uk', 2357 ],
  [ 'us', 2271 ],
  [ 'pl', 2262 ],
  [ 'common', 2205 ],
  [ 'public', 2076 ],
  [ '01', 2016 ],
  [ 'na', 1957 ],
  [ 'v2', 1954 ],
  [ '12', 1914 ],
  [ 'thumb', 1895 ],
  [ 'web', 1853 ],
  [ 'ui', 1841 ],
  [ 'default', 1825 ],
  [ 'main', 1737 ],
  [ 'false', 1715 ],
  [ '2018', 1697 ],
  [ 'embed', 1639 ],
  [ 'player', 1634 ],
  [ 'dist', 1599 ],
  [ 'woff', 1593 ],
  [ 'global', 1593 ],
  [ 'json', 1572 ],
  [ '11', 1566 ],
  [ '600', 1559 ],
  [ 'app', 1556 ],
  [ 'styles', 1533 ],
  [ 'plugins', 1526 ],
  [ '274', 1512 ],
  [ 'random', 1505 ],
  [ 'sites', 1505 ],
  [ 'imasdk', 1501 ],
  [ 'bridge3', 1501 ],
  [ 'news', 1496 ],
  [ 'width', 1494 ],
  [ 'thumbs', 1485 ],
  [ 'ttf', 1470 ],
  [ 'ajax', 1463 ],
  [ 'user', 1454 ],
  [ 'scripts', 1446 ],
  [ 'twitter', 1440 ],
  [ 'crop', 1431 ],
  [ 'new', 1412 ],
]);

const reToken = /[%0-9A-Za-z]+/g;

function badness(token) {
  return token.length > 1 ? BAD_TOKENS.get(token) || 0 : 1;
}

// Mirror of FilterCompiler#extractTokenFromQuerypruneValue(): when the pattern
// is `*` and the rule is a removeparam, uBO derives a token from the
// removeparam value itself, giving it a token lane.  Returns null when no
// token can be extracted (the rule stays in NO_TOKEN_HASH lane).
export function mirrorTokenFromQuerypruneValue(value) {
  if (value === '*' || value.charCodeAt(0) === 0x7e /* '~' */) return null;
  const regexMatch = /^\/(.+)\/i?$/.exec(value);
  if (regexMatch !== null) {
    return mirrorTokenFromRegex(regexMatch[1].replace(/(\{\d*)\\,/, '$1,'));
  }
  if (value.startsWith('|')) {
    return mirrorTokenFromRegex('\\b' + value.slice(1));
  }
  return mirrorTokenFromPattern(value.toLowerCase());
}

// Pragmatic mirror of FilterCompiler#extractTokenFromRegex().  Strips
// character classes, regex escapes, non-capturing groups, and quantifiers
// then runs the same lowest-badness token selection.  Not a perfect mirror
// of the engine's regex-analyzer-backed toTokenizableStr (some literal runs
// get lost), but captures the vast majority of real-world list regexes which
// contain plain `/literal/` segments.  Marked "(mirror)" in output.
export function mirrorTokenFromRegex(pattern) {
  let s = pattern
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\(\?:/g, ' ')
    .replace(/\\[dDwWsSbB]/g, ' ')
    .replace(/\\./g, ' ')
    .replace(/[^%0-9A-Za-z]+/g, ' ')
    .trim();
  const t = mirrorTokenFromPattern(s);
  if (t === null) return null;
  if (t.token === s || t.token.length === 1) return t;
  return { token: t.token.toLowerCase(), badness: t.badness };
}

// Mirror of FilterCompiler#extractTokenFromPattern(): the lowest-badness run,
// skipping any run adjacent to a '*' on the anchored side. Scans left to
// right, keeping the earliest occurrence of the lowest badness seen and
// stopping immediately on a zero-badness ("distinctive") token.
// Returns null when no token can be derived (the engine's tokenless case).
export function mirrorTokenFromPattern(pattern) {
  reToken.lastIndex = 0;
  let bestToken = null;
  let bestBadness = 0x7fffffff;
  for (;;) {
    const match = reToken.exec(pattern);
    if (match === null) break;
    const token = match[0];
    const b = badness(token);
    if (b >= bestBadness) continue;
    if (match.index > 0) {
      const c = pattern.charCodeAt(match.index - 1);
      if (c === 0x2a /* '*' */) continue;
    }
    if (token.length < MAX_TOKEN_LENGTH) {
      const lastIndex = reToken.lastIndex;
      if (lastIndex < pattern.length) {
        const c = pattern.charCodeAt(lastIndex);
        if (c === 0x2a /* '*' */) continue;
      }
    }
    bestToken = token;
    if (b === 0) break;
    bestBadness = b;
  }
  if (bestToken === null) return null;
  return { token: bestToken, badness: badness(bestToken) };
}