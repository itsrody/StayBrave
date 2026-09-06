# StayBrave Classic

**StayBrave Classic** is a Node.js pipeline that fetches, analyzes, validates,
and optimizes Adblock-Plus / uBlock Origin filter lists (EasyList, EasyPrivacy,
AdGuard, Fanboy, ABP, StevenBlack hosts, …) into a single, deduplicated, sorted
`output/StayBrave-Classic.txt` for **Firefox uBlock Origin 1.74+**.

Every rule in the output is validated by **uBlock Origin's own filter parser**
(`@gorhill/ubo-core` `AstFilterParser`) and the resulting file is compiled
through the real `StaticNetFilteringEngine` before anything can be committed. If
a rule survives the pipeline, uBO can parse and execute it.

The list deliberately excludes the lists uBO ships built-in (uAssets) and drops
every syntax uBO/Firefox cannot run, so the merged list is pure incremental
weight on top of uBO's defaults.

---

## Why Node.js?

- **Accuracy by construction** — the tool links `@gorhill/ubo-core`, the engine
  uBO itself uses (`AstFilterParser` for parsing, `StaticNetFilteringEngine`
  for network matching). There is no hand-rolled parser to drift out of sync
  with the browser extension.
- **uBO semantics, not Brave's** — unlike the previous adblock-rust-based build
  (Brave's blocker), this pipeline targets Firefox uBO. Rules uBO executes
  (`$popup`, `$empty`/`$mp4`, host-scoped scriptlets with `trusted-*` support,
  procedural cosmetics, HTML/responseheader filters) are kept, and rules uBO
  cannot execute are dropped with per-source causes.
- **No compilation step** — plain ESM on Node 20+, runnable anywhere.

---

## Pipeline

```
lists.json ──▶ Fetch ──▶ Preprocess ──▶ Normalize ──▶ Analyze ──▶ Optimize ──▶ Write
             (fetch)    (preprocess)  (normalize)  (analyze)  (optimize)   (writer)
                │             │             │            │          │            │
             concurrent   !#if/!#else   hosts→||^,  uBO's own   dedup +    ABP header +
             HTTP + ETag   !#include     redirect   parser      sort +     provenance
             cache         whitelist     aliases    validation  subsumption stats
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| Fetch | `src/fetch.js` | Concurrent downloads bounded by a semaphore, retries + exponential backoff, timeouts, an ETag/`If-None-Match` disk cache, and recursive `!#include` expansion. |
| Preprocess | `src/preprocess.js` | Evaluates uBO preparser directives (`!#if` / `!#else` / `!#endif`) against the desktop-Firefox token environment and resolves `!#include`. |
| Normalize | `src/normalize.js` | Translates cross-family syntax: hosts files to `||domain^`, strips hosting IP comments, drops `localhost` aliases, canonicalizes uBO/ABP redirect resource aliases. uBO-native `$empty`/`$mp4` pass through unchanged. |
| Analyze | `src/ubo.js` + `src/analyze.js` | Parses every line with uBO's own `AstFilterParser` (`trustedSource:false`, exactly like uBO 1.74+) and classifies results into statistics. Applies the cosmetic preprocessing uBO itself performs (dead-operator detection, procedural rewrite). |
| Optimize | `src/optimize.js` + `src/network.js` + `src/cosmetic.js` | Removes exact duplicates, sorts deterministically, applies provable network + cosmetic subsumption passes, and reports channel / token-bucket diagnostics. |
| Recheck | `src/engine.js` | Compiles the survivors through uBO's `StaticNetFilteringEngine` and certifies that nothing the Optimize passes removed still needs to block — any coverage hole aborts the build. |
| Write | `src/writer.js` | Emits `output/StayBrave-Classic.txt` with a full provenance/statistics header. |
| Config | `src/config.js` | Validates `lists.json`, merges defaults. |

---

## Setup

Requires **Node.js 20+** (developed against Node 25; CI uses Node 22).

```sh
npm install
npm test        # unit tests for the ported modules
npm run build   # node src/main.js → output/StayBrave-Classic.txt
npm run verify  # node examples/verify.js — independent gate on the output
```

## Usage

```sh
node src/main.js                          # lists.json → output/StayBrave-Classic.txt
node src/main.js --config lists.json      # explicit config path
node src/main.js -o /tmp/out.txt          # override output path
node src/main.js --offline                # never touch the network; .cache only
node src/main.js --help
```

| Flag | Default | Description |
| --- | --- | --- |
| `-c, --config` | `lists.json` | Path to the JSON config describing the lists to fetch. |
| `-o, --output` | `output/StayBrave-Classic.txt` (from config) | Output file path. |
| `--offline` | off | Serve everything from `.cache`; fail on any cache miss. |

---

## Configuration (`lists.json`)

```json
{
  "fetch": {
    "concurrency": 16,
    "timeout_secs": 30,
    "retries": 2,
    "retry_delay_ms": 500,
    "max_redirects": 5,
    "expand_includes": true,
    "max_include_depth": 4,
    "cache_dir": ".cache"
  },
  "output": {
    "file": "output/StayBrave-Classic.txt",
    "title": "StayBrave Classic",
    "expires": "3 days"
  },
  "filter": {
    "scriptlets": true,
    "keep_trusted_only": false,
    "network_optimize": true,
    "cosmetic_cost": {
      "split_comma_lists": false,
      "subsume_selectors": true,
      "subsume_procedural": true
    }
  },
  "provided_lists": [
    { "name": "uBO - Ads", "url": "https://ublockorigin.github.io/uAssets/filters/filters.txt", "enabled": true },
    { "name": "uBO - Badware risks", "url": "https://ublockorigin.github.io/uAssets/filters/badware.txt", "enabled": true },
    { "name": "uBO - Privacy", "url": "https://ublockorigin.github.io/uAssets/filters/privacy.txt", "enabled": true },
    { "name": "uBO - Quick fixes", "url": "https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt", "enabled": true },
    { "name": "uBO - Unbreak", "url": "https://ublockorigin.github.io/uAssets/filters/unbreak.txt", "enabled": true },
    { "name": "uBO - Annoyances", "url": "https://ublockorigin.github.io/uAssets/filters/annoyances.txt", "enabled": true }
  ],
  "lists": [
    { "name": "EasyList", "url": "https://easylist.to/easylist/easylist.txt", "enabled": true },
    { "name": "StevenBlack hosts", "url": "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", "enabled": true, "hosts": true }
  ]
}
```

### Fields

- `fetch` — all optional:
  - `concurrency` bound on parallel HTTP requests.
  - `timeout_secs`, `retries`, `retry_delay_ms` — transient/5xx retry policy.
  - `max_redirects` — HTTP redirect limit.
  - `expand_includes` + `max_include_depth` — resolve uBO `!#include` directives.
  - `cache_dir` — ETag cache directory (committed-free; `.gitignore`d). Each URL
    is cached at `<sha256(url)>.json`; cache hits return 304s and skip re-download.
    Sources whose CDN bumps a version ETag without changing bytes (e.g.
    easylist.to) are still treated as cache hits: the body is kept, only the
    validators are refreshed, so "fetched" only counts genuinely new content.
- `output` — `file` (default output path, CLI `-o` overrides it), `title`,
  `description`, `expires`, `homepage` (all written into the ABP header).
- `filter` — optional:
  - `scriptlets` (default `true`) — drop generic uBO scriptlet rules
    (`##+js(...)`) and legacy `script:inject`. Host-scoped scriptlets are kept
    only while `scriptlets` is enabled, and `trusted-*` scriptlets are dropped
    unless `keep_trusted_only` is `true` (the pipeline parser runs
    `trustedSource:false`, matching a normal Firefox uBO).
  - `keep_trusted_only` (default `false`).
  - `network_optimize` (default `true`) — run the network / scoped subsumption
    passes.
  - `cosmetic_cost` — independent toggles for the cosmetic passes
    (`split_comma_lists` default off — pure-CSS comma lists are canonicalized
    to grouped form instead of split; `subsume_selectors`, `subsume_procedural`
    default on).
- `lists` (required) — array of sources:
  - `name` (required) — display name used in logs and the header.
  - `url` (required) — http(s) URL of the raw filter list.
  - `enabled` (optional, default `true`) — keep a list in the config without
    fetching it.
  - `hosts` (optional, default `false`) — treat the list as hosts-file syntax:
    `#`/`!` comments dropped, IP-led or bare-domain lines become `||domain^`
    rules. Required for StevenBlack/hosts.
- `provided_lists` (optional, default `[]`) — array of `{ name, url, enabled }`
  describing external lists the *user* has already enabled in uBO (such as
  uBO's built-in "Ads", "Badware risks", "Privacy", "Quick fixes", "Unbreak",
  "Annoyances"). Every rule from StayBrave-Classic that one of these lists
  already provides — textually identical or provably covered, see
  `src/provided.js` — is dropped from the output, so no rule is duplicated or
  flagged "unused" in the combined install. Coverage is unchanged relative to
  (StayBrave-Classic + these lists). `enabled: false` disables one entry; remove
  the whole block to keep the output self-contained for users who do not enable
  these lists in uBO.

---

## How it works

### 1. Fetch (`src/fetch.js`)

- Only `enabled` lists are fetched, concurrently up to `fetch.concurrency`.
- A permanent **ETag cache** lives in `fetch.cache_dir` (`.cache/`): each fetch
  re-sends `If-None-Match` / `If-Modified-Since`; a 304 reuses the cached body.
  This makes rebuilds near-instant and `--offline` reproducible.
- Failed/5xx responses retry with exponential backoff; other statuses fail.
- Responses are decoded lossily to UTF-8.
- `!#include` directives are resolved (relative against the including file's
  URL, http(s) only) with cycle detection and `max_include_depth`; a failed
  include becomes a `! StayBrave: …` comment so nothing is silently lost.

### 2. Preprocess (`src/preprocess.js`)

uBO lists use preparser directives. The pipeline runs the same token logic as
uBO's `preparser.js` with a whitelist centered on the desktop-Firefox uBO
target: `ublock`, `firefox`, `html_filtering`, `user_stylesheet` are `true`;
AdGuard tokens such as `adguard_ext_firefox` map to `firefox`; everything else
(Chrome/Safari/Android/MV3/trusted/AdGuard-specific) evaluates `false`. Branch
bodies are expanded and their lines included; excluded branches are dropped,
so platform-specific additions never leak into the merged list.

### 3. Normalize (`src/normalize.js`)

- **Hosts files**: drop comments, skip `localhost`/`ip6-*`/`broadcasthost`
  aliases and invalid hosts, emit `||domain^` for every other bare domain.
- **Redirect alias canonicalization**: `$redirect` / `$redirect-rule` /
  `$rewrite` resource values are mapped to canonical uBO names
  (`noopjs` → `noop.js`, `noopmp4-1s` → `noop-1s.mp4`, `abp-resource:`-prefixed
  aliases stripped), matching the token set uBO 1.74+ ships.
- **uBO-native shorthands pass through**: `$empty` / `$mp4` / `$mp3` — the
  shorthand → `$redirect=` expansion is *already* internal to uBO >= 1.63, so
  rules are kept verbatim (`$mp3` only where uBO validates it).
- Every translated line is still re-parsed by the real parser in Analyze, so a
  rewrite can never silently change semantics — if it no longer parses, it is
  dropped.

### 4. Analyze (`src/ubo.js`, `src/analyze.js`)

Each line is parsed with **uBO's own `AstFilterParser`** run exactly as uBO
1.74+ does for a normal (non-advanced/trusted) installation. One parser
instance is created per whole pipeline run (not per source) and reused for
every line — mirroring uBO itself, whose single `AstFilterParser` parses the
entire enabled asset set. `parse()` rewinds the node pool and zeroes every
node field, so a shared instance is fully state-independent between lines
(this is asserted in `test/ubo.test.js`). Results are classified and counted:

| Bucket | Meaning | Action |
| --- | --- | --- |
| `network` | Valid static network filter | kept → `src/network.js` |
| `cosmetic` (`##`, `#?#`, `#@#`) | Valid cosmetic filter | kept → cosmetic pipeline |
| `scriptlet` (`##+js`, `#@#+js`) | Scriptlet injection | kept only if host-scoped and `scriptlets` enabled; generic dropped |
| `html` (`##^`) | HTML filtering | kept (uBO 1.74 handles it) |

With `interactive: true` the parser runs its full validation: cosmetic
selectors through `ExtSelectorCompiler`, network pattern-part AST, and the
trusted-scriptlet check. Our `TRUSTED_SCRIPTLET_TOKENS` set is passed as the
parser's `trustedScriptletTokens` option, so a `trusted-*` scriptlet from a
non-trusted source is flagged `AST_ERROR.UNTRUSTED_SOURCE` by uBO's parser
itself (dropped in Analyze) rather than by a hand-rolled mirror; the
`trusted-` prefix check is kept as a superset safety net.
| `responseheader` (`^responseheader`) | Response-header modifier | kept |
| `unsupported` | Comment/header/`$$` AdGuard cosmetics | skipped (counted) |
| `unsupported_options` | Parseable but carries a modifier uBO rejected (`$urlskip`, `$replace`, `$dnsrewrite`, `$web_accessible_resource`, … — all the `trustedSource`/option-validation drops) | dropped (counted) |
| `invalid` | Parser error (`astError != 0`, or the embedded `ExtSelectorCompiler` rejecting a CSS-invalid cosmetic selector such as `.bad{selector}` via `HAS_ERROR`) | dropped (counted) |

Classification uses the parser's own predicates (`isNetworkFilter`,
`isCosmeticFilter`, `isScriptletFilter`, `isHtmlFilter`,
`isResponseheaderFilter`, `isComment`) — the exact checks the shipped engine's
compiler makes when it decides how to treat a line. `parseLine` also surfaces
`parser.result.error` as `selectorError` (the ExtSelectorCompiler's position
message, which is sticky across `parse()` and reset per line) so cosmetic
rejections explain themselves.

Because ABP ships `#$#`/`#%#` *snippet* syntax that uBO parses as style
injection with a bogus selector, every ABP anti-circumvention snippet line
lands in `invalid` and is dropped — uBO could not execute it anyway.

The cosmetic pass also runs the transformations uBO itself applies
(`src/cosmetic.js`): procedural canonicalization (`:contains(`→`:has-text(`,
`:-abp-contains(`→`:has-text(`, `:nth-ancestor(`→`:upward(`), dead-operator
detection (`:others(`, `:-abp-properties(` are no-ops in uBO → dropped),
`splitCosmetic` guard so `#?#`/`##^`/`^responseheader` are routed correctly,
and cosmetic stats (`plainBase`, channels, `LocToken`).

### 5. Optimize (`src/optimize.js`, `src/network.js`, `src/cosmetic.js`)

After exact-string dedup and deterministic sort:

- **Network subsumption** — option-less block rules (`||host^`, `||host/path^`)
  are parsed into host/path (`parseSimpleRule`) and the set is greedily
  rechecked broadest-first. A rule is dropped when a kept rule covers it:
  same-host with a `/` terminator, one path a `/`-boundary prefix of another,
  or the exact host with `^`. `$`-option rules, exceptions (`@@`), regex/`*`
  patterns, wildcard hosts (`*.example.com`), uppercase hosts, and
  `$domain`-restricted rules are opaque. `$badfilter` pairs are stripped first
  (`stripBadfilterPairs`), and wildcard-TLD `$domain=….*` rules are preserved
  but counted (`countWildcardDomainRules`).
- **Scoped subsumption** — an option-less rule dominates the same rule carrying
  any subset of the *subsumable* option set (`script, image, stylesheet,
  object, object-subrequest, media, subdocument, ping, xmlhttprequest, xhr,
  websocket, font, other, http, https, third-party, first-party`). uBO's
  engine was verified via `StaticNetFilteringEngine.matchRequest`: an
  option-less rule **never** matches a `popup` request type, so `$popup` (and
  `document`, `important`, `redirect*`, `domain`, `badfilter`) are excluded —
  a `$popup` rule is never collapsed into an option-less variant and is
  preserved as-is.
- **Cosmetic subsumption** (`src/cosmetic.js`) — among host-scoped pure-CSS
  rules with an identical selector and kind, a narrower host scope is dropped
  when a broader one covers it (subdomain families share uBO's hostname-probe
  channel order). Entity locations (`example.*`) participate as covers via the
  registrable-domain suffix set (`tldts`); a full hostname never covers an
  entity. Negated locations (`~x`, `~x.*`) and procedural selectors stay
  opaque, and generic rules never cover host-scoped ones (uBO `$generichide`).
- **Cosmetic cost passes** — `subsume_selectors` removes rules provably covered
  by a broader-scope same-selector rule or (generic channel only) a cheaper
  bare-token rule `##.ad` covering `##div.ad`, iterated to a fixpoint;
  `subsume_procedural` removes a procedural rule covered by a plain rule on the
  same `plainBase` selector or an identical procedural selector on a strictly
  broader scope.
- **Diagnostics** — `channelCounts` bins cosmetic rules into uBO's delivery
  channels (simple class/id, complex token-led, generic-misc, hostname-hide,
  hostname-unhide, procedural); `tokenBucketEstimate` estimates uBO's network
  token-bucket split (hostname-tokened vs. catch-all bucket-0 rules).

### 5a. Engine-certified optimizer recheck (`src/engine.js`)

Every rule the subsumption passes remove is now certified by uBO's own
engine before it can be committed. `verifyRemovedCoverage` compiles the
*survivors* through `StaticNetFilteringEngine`, synthesizes the exact request
a removed `||host/path^$opts` rule used to block (`removedProbe` — honoring
the rule's type, scheme, party constraint and path, skipping regex/plain
patterns it cannot probe cheaply), and requires that request to still be
blocked. If it is not, the rule's removal is re-probed against the
pre-optimization set: blocked there means a real coverage hole (build
aborts); still not blocked means an exception such as `@@||host^` legitimately
cancelled it and the removal is safe. A bounded sample (default 2000, spread
evenly across the removed set) is verified every build — a pass-bug can no
longer silently ship a coverage gap.

### 5b. Provided-list subtraction (`src/provided.js`)

When `provided_lists` is non-empty, each listed URL is fetched and treated as
already-present coverage rather than merged output. `subtractProvided` then
drops from the optimized rules any rule one of those lists already provides:

- **Exact-text** — any rule whose text appears verbatim in a provided list.
- **Network** — an option-less `||host…` rule covered by a provided option-less
  `||host…` rule (label-suffix host and `/`-boundary path prefix), matching
  uBO's hostname-suffix matching.
- **Cosmetic** — a `##`/`#?#` rule whose selector appears in a provided list on
  a broader or equal host scope (plain `example.com` covers `www.example.com`,
  `example.*` covers concrete hosts under it, and a plain rule covers a
  procedural rule on the same `plainBase`).

Everything kept is unchanged. This is what keeps the combined install free of
"unused duplicate rules": StayBrave-Classic no longer ships the subset that
uBO's other enabled lists already supply. Run `node examples/verify.js` after
rebuilding to confirm the reduced file still compiles cleanly.

### 6. Write (`src/writer.js`)

Output starts with `[Adblock Plus 2.0]` and the ABP metadata header (`! Title`,
`! Version: YYYYMMDDHHMM`, `! Description`, `! Expires: 3 days`, `! Homepage`,
`! Last modified`), followed by:

- Per-source provenance: bytes, `! included files`, line counts, kept
  network/cosmetic/html/scriptlet/responseheader rules, invalid / unsupported /
  unsupported-options counts, hosts converted, and whether it came from cache.
- Global totals: input rules, unique rules, duplicates removed, network / scoped
  / cosmetic / procedural subsumed, redirect rewrites, cosmetic transforms,
  wildcard-TLD `$domain` rules, the token-bucket split, and the cosmetic
  channel distribution.

`Version` is the generation timestamp (UTC, EasyList-style), so every build is
monotonic and uBO only re-downloads on change.

---

## Output format (`output/StayBrave-Classic.txt`)

- Lines beginning with `!` are comment/header lines (ignored by uBO).
- Every non-comment line is a validated, deduplicated, sorted filter rule.
- No `#`/`$` shorthand is left uncanonicalized; `$empty`/`$mp4` appear
  verbatim because uBO ≥ 1.63 expands them internally (verified with the real
  parser). `$popup` rules are preserved. Host-scoped scriptlets are preserved.
- Batch behavior is verified independently — see below.

### Known behavior / limitations

- **Rules uBO rejects are dropped.** Anything that fails
  `AstFilterParser` with `trustedSource:false`, carries a `trustedSource`-only
  option, or is dead in uBO 1.74 (`:others(`, `:-abp-properties(`, ABP
  `#$#`/`#%#` snippets) is never written and counted per source.
- **Generic scriptlets are dropped**; host-scoped scriptlets survive. This
  matches uBO's own limit that generic scriptlet injection is meaningless
  without a hostscope and that `trusted-*` scriptlets need the advanced
  mode.
- **Cosmetic section separators are not written.** Adblock-style `[Section]`
  headers would be parsed as network filters, so sections are omitted; the
  list is one flat sorted set.
- **Deduplication is exact-text**, not semantic — uBO normalizes equivalent
  rules internally at load time.
- **Wildcard-TLD `$domain=….*` rules are kept and counted**, never dropped
  (dropping one would broaden blocking), but mirror how uBO's parser treats
  them (kept, hashed verbatim).
- **Case-insensitive subsumption, original case preserved** — network
  subsumption compares paths/hosts case-insensitively (matching the engine's
  lowercasing) while the survivor keeps its original text. Sources are
  lowercase in practice.
- **Never broadens**: every subsumption removes a rule *covered by* a retained
  rule. Probes in Verify catch any mis-dropped rule.

---

## Verification (`examples/verify.js`)

An independent gate, run on the *output file* before it can be committed:

```sh
node examples/verify.js [output] [probeLimit]
```

1. **Parser gate** — every rule is reparsed with `AstFilterParser`
   (`trustedSource:false`); any line flagged `hasError()` — which includes
   cosmetic selectors the embedded ExtSelectorCompiler rejects even when
   `astError` is 0 (e.g. `.bad{selector}`) — fails the gate.
2. **Engine gate** — the whole file is compiled through the real
   `StaticNetFilteringEngine` (`useLists`); any dropped line (surfaced via the
   `events` callback) fails the gate.
3. **Liveness probes** — up to `probeLimit` (default 2000) simple option-less
   `||host^` / `||host/path^` rules are probed with synthetic script requests
   through `matchRequest`; a rule that fails to block (result `& 1` == 0) means
   the optimizer mis-dropped or over-staticized it and fails the gate.
4. **Engine registration metric** — `getFilterCount()` (same count uBO's
   dashboard "used" counter derives from) is compared against the network-line
   total; a large shortfall (engine silently dropped rules) fails the gate.
   Cosmetic rules never enter the SNFE, so the expectation is `units >= lines`;
   the surplus comes from `$redirect`/`$redirect-rule` double-registration.
5. **Modifier probes** — a sample of host-anchored `$removeparam` (via
   `filterQuery`), `$csp`, `$permissions` and `$uritransform` rules is probed
   with synthetic requests through `matchAndFetchModifiers`; zero matches for a
   modifier class that ships rules fails the gate. `$redirect`/`$redirect-rule`
   are intentionally not probed — this ubo-core build surfaces them only through
   `redirectEngine`, which requires an external redirect-resource engine.
6. **Token profile** (informational) — every network rule is classified into
   uBO's onBeforeRequest dispatch lanes via `src/tokens.js`, a mirror of
   `FilterCompiler#makeToken`: pure hostname-dictionary (`||host^` / bare
   `host`, probed without URL tokenization), distinctive-token (lowest-badness
   run of `[%0-9A-Za-z]+`, matched only when that token is in the URL),
   generic-token (in the engine's collated `badTokens` histogram, e.g. `cdn`,
   `www`), 1-char-token, tokenless (`*ads*` — tested on every request), and
   regex (token not mirrored). `BAD_TOKENS` parity with the pinned engine
   source is asserted in `test/tokens.test.js`, so a ubo-core bump that
   re-collates the histogram fails loudly. The formula this measures: rules
   should be hostname-anchored, carry a distinctive token in their pattern, and
   never abut a wildcard with their token run. Current output: 422,391 of
   423,059 network rules (99.8%) are dispatch-cheap.

Output ends with `exit: PASS` / `exit: FAIL`. `npm run verify` uses the
defaults; the GitHub workflow runs it with the concrete output path.

---

## Extending

- **Add a source** — append a `lists` entry to `lists.json`. Anything that
  parses cleanly flows through; anything uBO rejects is counted and dropped.
- **Cache control** — delete `.cache/` to force a full re-download; use
  `--offline` to assert reproducibility from cache alone.
- **On-demand local builds** — `npm run build` then load
  `output/StayBrave-Classic.txt` in uBO (Customize → My filters, or the
  "Import and apply from file" option).
- **Trusted/advanced mode output** — toggle `filter.keep_trusted_only` to
  retain `trusted-*` scriptlets (and parse with `trustedSource:true`).

Browser target is Firefox uBO 1.74+; a Chromium variant would swap the
preprocessor environment tokens and re-run Verify's request-type matrix.

---

## License

MPL-2.0 (this tool and the generated list). The `@gorhill/ubo-core` dependency
used for validation is GPL-3.0 and is only an orchestration-time dependency —
it is not shipped, bundled, or linked into the generated list.