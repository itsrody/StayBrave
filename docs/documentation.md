# StayBrave Classic

**StayBrave Classic** is a Node.js pipeline that fetches, analyzes, validates,
and optimizes Adblock-Plus / uBlock Origin filter lists (EasyList, EasyPrivacy,
AdGuard, Fanboy, ABP, StevenBlack hosts, …) into a single, deduplicated, sorted
`output/StayBrave-Classic.txt` for **Firefox uBlock Origin 1.74+**.

Firefox uBO is the browser/blocker pair where uBO's exclusive capabilities
exist — CNAME uncloaking, `ipaddress=` filtering, HTML filtering and
response-body filtering all require Firefox webRequest APIs. StayBrave-Classic
is built *to* Firefox, not merely *for* it: the pipeline preserves every rule
only Firefox can execute, drops the rest with a per-source cause, and certifies
coverage through uBO's own engines (see [Firefox-exclusive capabilities](#firefox-exclusive-capabilities)).

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

## Firefox-exclusive capabilities

uBO's own wiki is explicit: *"uBlock Origin works best on Firefox."* The
filter-relevant reasons and how this pipeline leans into each:

| Capability | Syntax | Firefox means | Pipeline stance |
| --- | --- | --- | --- |
| CNAME uncloaking | `$cname` | uBO resolves the DNS chain and re-filters requests whose CNAME exposes a 3rd-party server as 1st-party | `$cname` rules pass through untouched |
| IP-address filtering | `$ipaddress=` | DNS-resolved IP available at onBeforeRequest; `lan`/`loopback`/regex/`192.168.*` values | kept, counted, never subsumed (`SUBSUMABLE_OPTIONS` whitelist) |
| HTML filtering | `##^` | `webRequest.filterResponseData()` prunes the response body before the browser parses it | classified `html`, preserved; opaque to cosmetic passes |
| Response-header filtering | `##^responseheader(n: v)` | header removal/modification only possible with Firefox webRequest | classified `responseheader`, preserved |
| Response-body filtering | `$replace=` | `filterResponseData()`-based rewrite of CSS/JS/HTML bodies | trusted-source-only: shipped only under `filter.keep_trusted_only` |

Every build reports these counts (`html_filters`, `responseheaders`, `scriptlets`,
`ipaddress`, `cname`, `csp`) in the output header and the CLI summary, so the
Firefox-exclusive payload is visible at a glance (`firefox_exclusive` on the
optimized result; `countFirefoxExclusives` in `src/optimize.js`).

`$replace=`, `$uritransform`, `$urlskip` require a trusted-source origin. uBO
grants trust by URL prefix — **not** by an in-list directive — through the
advanced setting `trustedListPrefixes`. To ship those rules: set
`filter.keep_trusted_only: true` and add this list's URL to
`trustedListPrefixes`; the writer header reminds the operator either way.

---

## Pipeline

```
lists.json ──▶ Fetch ──▶ Preprocess ──▶ Normalize ──▶ Analyze ──▶ Optimize ──▶ Cosmetics ──▶ Write
             (fetch)    (preprocess)  (normalize)  (analyze)  (optimize)  (cosmetic-   (writer)
                │            │              │            │          │        engine)         │
             concurrent  !#if/!#else  hosts→||^,   uBO's own   dedup +    abort rules    ABP header +
             HTTP + ETag  !#include   redirect     parser      sort +     uBO would     provenance
             cache        whitelist   aliases      validation  subsumption drop at load  stats
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| Fetch | `src/fetch.js` | Concurrent downloads bounded by a semaphore, retries + exponential backoff, timeouts, an ETag/`If-None-Match` disk cache, and recursive `!#include` expansion. |
| Preprocess | `src/preprocess.js` | Evaluates uBO preparser directives (`!#if` / `!#else` / `!#endif`) against the desktop-Firefox token environment and resolves `!#include`. |
| Normalize | `src/normalize.js` | Translates cross-family syntax: hosts files to `||domain^`, strips hosting IP comments, drops `localhost` aliases, canonicalizes uBO/ABP redirect resource aliases. uBO-native `$empty`/`$mp4` pass through unchanged. |
| Analyze | `src/ubo.js` + `src/analyze.js` | Parses every line with uBO's own `AstFilterParser` (`trustedSource:false`, exactly like uBO 1.74+) and classifies results into statistics. Applies the cosmetic preprocessing uBO itself performs (dead-operator detection, procedural rewrite). |
| Optimize | `src/optimize.js` + `src/network.js` + `src/cosmetic.js` + `src/rewrite.js` + `src/efficiency.js` | Canonicalizes net-option spellings to uBO's strict grammar (`$1p`→`$first-party`, pattern-less → `*`, options sorted with exact duplicates collapsed), removes exact duplicates, sorts deterministically, applies provable network + cosmetic subsumption passes, emits engine-gated superset/dead-rule/dead-exception candidates, and reports SNFE-mirrored token-bucket + A–F efficiency grades. |
| Cosmetics | `src/cosmetic-engine.js` + `vendor/ubo/` | Runs every `##`/`#@#` rule through uBO's vendored `CosmeticFilteringEngine` (identical parser + writer/reader) and removes the rules stock uBO drops at load — the generic procedural filters that `allowGenericProceduralFilters:false` discards. `filter.cosmetic_engine_filter` gates the pass (default on). |
| Recheck | `src/engine.js` + `src/cosmetic-engine.js` | Gates the superset/dead-rule/dead-exception candidates through uBO's own static network + cosmetic engines (only engine-certified removals ship), then compiles the survivors and certifies that nothing Optimize passed removed still needs to block — any coverage hole aborts the build. |
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
    "rewrite_canonical_options": true,
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
  - `keep_trusted_only` (default `false`) — parse with `trustedSource:false`,
    matching a normal Firefox uBO: `trusted-*` scriptlet *blocks* and network
    options that require trust (`$replace=`, `$uritransform`, `$urlskip`) are
    dropped and counted under `trusted_source_dropped`. Exceptions (`#@#+js`,
    `@@`) are exempt from the trust requirement and always kept.
  - `network_optimize` (default `true`) — run the network / scoped subsumption
    passes.
  - `rewrite_canonical_options` (default `true`) — rewrite network option
    spellings to uBO's canonical long-form names (`$1p`→`$first-party`,
    `$3p`→`$third-party`, `$xhr`→`$xmlhttprequest`, `$doc`, `$frame`, … from
    the parser's own synonym map) *before* dedup. Provably semantics-preserving
    (synonym options resolve to the same node type), lets alias-spelled twins
    collapse into one rule, and makes scoped subsumption see the exact spelling
    uBO's engine stores. Counted in the header as `Rewrites`.
  - `network_superset_subsumption` (default `true`) — emit *candidate* superset
    (broader host/path/type/scope block) removals. Nothing is removed on the
    predicate's word alone: every candidate is probed through uBO's own
    `StaticNetFilteringEngine` and only certifiable removals are shipped (see
    the engine gates below). Also gates the dead-by-exception network pass when
    `network_dead_by_exception` is `true`.
  - `network_dead_by_exception` (default `true`) — emit *candidate* network
    dead-block removals: a block whose requests an exception already unbinds
    across its whole scope. Engine-certified before removal.
  - `cosmetic_engine_filter` (default `true`) — run the merged rules through
    uBO's vendored cosmetic engine and drop the generic procedural filters
    stock uBO discards at load (see 5c).
  - `cosmetic_dead_hide_by_exception` (default `true`) — emit *candidate*
    cosmetic A/C dead-hide removals: a same-selector non-procedural hide whose
    selector an exception already withdraws across its whole scope (equal,
    broader-host, or generic exception). Engine-delivery-certified before
    removal.
  - `network_dead_exception` (default `true`) — emit *candidate* dead
    `@@` network-exception removals: a whitelist rule that (per the
    host/path/type/party/scope indexing in `subsumeDeadExceptions`) suppresses
    no surviving block. Each candidate is probed through uBO's own
    `StaticNetFilteringEngine` with the candidate excluded from the survivors —
    an exception must not certify itself — and only exceptions whose removal
    provably changes no request outcome are shipped.
  - `cosmetic_dead_exception` (default `true`) — emit *candidate* dead `#@#`
    cosmetic-exception removals: an exception whose selector no weak `##` hide
    carries (a strong `#?#` hide is never withdrawn by a weak exception, so it
    cannot keep one alive). Engine-delivery-certified before removal (see 5d).
  - `cosmetic_cost` — independent toggles for the cosmetic passes
    (`split_comma_lists` default off — pure-CSS comma lists are canonicalized
    to grouped form instead of split; `subsume_selectors`, `subsume_procedural`
    default on). `merge_same_scope_selectors` (default on) is the writer's
    repacking pass: after verification, each scope's pure-CSS cosmetic rules
    (`a.com##.x` + `a.com##.y`) collapse into one comma-separated line
    (`a.com##.x,.y`). uBO delivers a comma list as a single native CSS rule,
    so no selector or delivery behaviour changes — only the duplicated
    `a.com##` prefixes and newlines disappear. Procedural/action selectors,
    scriptlets and HTML filters are never merged.
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
`trusted-` prefix check is kept as a superset safety net for blocks only —
uBO exempts *exception* scriptlets from requiring a trusted source
(`validateExt()` breaks on `isException` first), so `#@#+js(trusted-*)` rules
survive analysis even under `keep_trusted_only:false`, matching stock uBO.
| `responseheader` (`^responseheader`) | Response-header modifier | kept |
| `unsupported` | Comment/header/`$$` AdGuard cosmetics | skipped (counted) |
| `trusted_source_dropped` | Parseable but rejected because the source is not trusted (`$replace=`, `$uritransform`, `$urlskip`, trusted-`*` scriptlet blocks — uBO ignores exceptions here) | dropped (counted) |
| `unsupported_options` | Parseable but carries a modifier uBO rejected with a *non*-trust reason (`$dnsrewrite`, `$web_accessible_resource`, unknown/duplicate options, …) | dropped (counted) |
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
- **Superset subsumption (candidate-only, engine-gated)** — a block `v` is a
  *candidate* for removal when a broader surviving block provably covers its
  requests: equal or label-suffix host that spans all of `v`'s paths (an
  optionless suffix cover must span every path; a same-host path-prefix cover
  suffices), a type mask `⊇ v`'s (an optionless `||host^` is the
  `OPTIONLESS_TYPES` mask — it does **not** cover `$document`/`$popup`, so those
  victims are never candidates), matching party, and a domain scope `⊇ v`'s (a
  bare rule covers all documents; a `domain=`-scoped survivor never covers an
  unscoped victim). The predicate also produces **dead-by-exception** network
  candidates: a block whose requests an exception already unbinds across its
  whole scope. These passes are deliberately permissive and never remove on the
  predicate's word alone — everything routes through the engine gates below.
- **Cosmetic A/C dead hides (candidate-only, engine-gated)** — a same-selector
  non-procedural hide is a *candidate* when an exception withdraws that selector
  across its whole scope: an equal scope (`a.com#@#.ad` kills `a.com##.ad`), a
  broader-host scope (`a.com#@#.ad` kills `sub.a.com##.ad`), or a generic
  exception (`#@#.ad` kills `a.com##.ad`, engine-verified that cosmetic
  exceptions cancel host-scoped hides). A narrower exception never kills a
  broader or generic hide. Delivery changes are certified by the cosmetic engine
  gate before any removal.
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

### 5aa. Superset / dead-rule engine gates (the source of truth)

The superset and dead-rule candidates above are over-approximations: uBO's
`domain=` scope and party masking interact in ways a host-suffix predicate
cannot fully predict (the engine oracle has caught genuine holes). Nothing is
removed on the predicate's word alone. Two gates make the shipped removals
*provable-by-construction*:

- **Network gate** (`certifySupersetRemovals`): every candidate is probed
  through `StaticNetFilteringEngine` against the survivor set **with all
  candidate rules removed** (so a candidate can never certify itself; the view
  is unchanged for genuinely covered removals, since the cover relation is
  acyclic and a covered request stays blocked by the chain's non-candidate
  maximum). Superset candidates must remain **blocked**; dead-by-exception
  candidates must remain **unblocked** (the exception still unbinds them). A
  `domain=`-scoped victim is probed at its own document hosts, in addition to
  a synthetic third-party origin, so the scope a removal would affect is the
  scope that is exercised. Only candidates certified on every relevant origin
  are removed.
- **Cosmetic gate** (`certifyCosmeticDeadHides`): each A/C candidate hide's
  selector must be absent from uBO's vendored cosmetic engine retrieval
  (`retrieveSpecificSelectors`) at every positive host of the hide's scope —
  proving the exception already withholds it, so removing the rule cannot
  change delivered cosmetic filtering.

Both gates run in the pipeline (recording `superset_candidates` /
`superset_removed` / `cosmetic_dead_candidates_count` /
`cosmetic_dead_removed` in the output header) before the recheck below; the
certified network removals are folded back into the set `verifyRemovedCoverage`
samples, so nothing engine-certified can bypass the existing coverage gate.

### 5ab. Dead exception gates (inert rules, not silently kept)

Bad *format* rules — `@@` whitelists that suppress no surviving block and `#@#`
exceptions whose selector no hide carries — are not just slow, they are inert:
uBO still indexes and tests them on every matching request. Two more gates
certify their removal.

- **Network dead-exception gate** (`certifyDeadExceptionRemovals`): the
  candidate set comes from `subsumeDeadExceptions`, which indexes every block
  (exact-host buckets plus label-suffix buckets, all paths — a pathless
  exception also reaches a deeper host's path-prefixed block) and keeps only
  exceptions no block can reach, after skipping `~`/negated, unparseable and
  modifier-carrying shapes. For each candidate the gate probes against the
  survivor set **with the candidate excluded**, at the exception's own
  first-party context (unless the exception is party-unpinned), the first
  positive `domain=` document host, and a synthetic third-party origin; when
  the exception is not type-pinned, every uBO request type is probed so a
  type-restricted binding block still surfaces. A candidate is certified only
  if **every** probe is unblocked — with the exception present elsewhere, so a
  single blocked probe marks it rejected (a later unblocked probe cannot
  resurrect it). Exceptions are the one rule that could certify themselves, so
  the exclusion here is mandatory, and because the candidates index
  `optimized.rules`, the pair-removal case (dead block + its exception) can
  never arise: an exception that binds a block is not a candidate in the first
  place.
- **Cosmetic dead-exception gate** (`certifyDeadCosmeticExceptions`): each
  candidate `#@#` exception (from `deadCosmeticExceptions`, which compares
  against weak `##` hides only, and skips HTML, response-header and `+js`
  scriptlet exceptions as opaque to the engine) is probed at every positive
  host of its scope through uBO's vendored cosmetic engine with the candidates
  removed from the rule set; a certificate is issued exactly when the selector
  appears in neither the injected selectors nor the procedural filters — the
  removal delivers nothing the hide rules were not already withholding.
  Engine-verified and pinned: a strong `#?#` hide is *not* withdrawn by a weak
  exception, so a strong hide never keeps an exception alive.

Both gates record `engine_dead_exception_candidates_count` /
`engine_dead_exception_removed` and `cosmetic_dead_exception_candidates_count`
/ `cosmetic_dead_exception_removed` in the output header. They run against the
*post-superset* survivor set, after the network-removal gate above, so their
certificates reflect exactly what ships.

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

### 5c. Cosmetic engine filtering (`src/cosmetic-engine.js`, `vendor/ubo/`)

The optimizer is network-truth; the cosmetic half is validated against the real
uBO cosmetic engine. `@gorhill/ubo-core` ships no `cosmetic-filtering.js`, so
uBO's own is vendored (byte-for-byte, pinned commit `869e052a…`, see
`vendor/ubo/README`), wired to Node through three tiny shims (`vAPI`,
`logger.js`, `background.js` — the latter fixes
`allowGenericProceduralFilters:false`, the stock Firefox default). The build
then does what uBO itself does on each list: `AstFilterParser` → `engine.compile`
→ `CompiledListWriter` → `CompiledListReader` → `engine.fromCompiledContent`.

That surfaces every rule stock uBO will discard at list load — the **generic
procedural cosmetic filters** (`##div:has(…)`, `##foo:style(…)` with no
positive host). None of them ever runs in a default uBO, so the pass removes
them from the output (`filter.cosmetic_engine_filter`, default on) and the
build logs how many were dropped. Host-anchored procedural filters, entity
(`a.*`) rules and `#@#` exceptions all compile and stay.

### 5d. Write (`src/writer.js`)

Output starts with `[Adblock Plus 2.0]` and the ABP metadata header (`! Title`,
`! Version: YYYYMMDDHHMM`, `! Description`, `! Expires: 3 days`, `! Homepage`,
`! Last modified`), followed by:

- Per-source provenance: bytes, `! included files`, line counts, kept
  network/cosmetic/html/scriptlet/responseheader rules, invalid / unsupported /
  unsupported-options counts, hosts converted, and whether it came from cache.
- Global totals: input rules, unique rules, duplicates removed, network / scoped
  / cosmetic / procedural subsumed, redirect rewrites, cosmetic transforms,
  wildcard-TLD `$domain` rules, the token-bucket split, the cosmetic
  channel distribution, and the count of dead cosmetic rules the engine pass
  removed.

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
- **Generic procedural cosmetic filters are removed by the engine pass** —
  `##div:has(…)`, `##foo:style(…)` and friends with no positive host are dead
  in a default Firefox uBO (`allowGenericProceduralFilters:false`), so
  `src/cosmetic-engine.js` compiles every `##`/`#@#` rule with uBO's own
  engine at build time and drops the ones it refuses to load. Host-anchored
  procedural rules stay.
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
6. **Dispatch profile** (informational) — after compilation the engine's own
   `bucketHistogram()` enumerates every registered network unit and the token
   hash it is stored under in its realm bucket. That is uBO's actual
   onBeforeRequest dispatch: `DOT_TOKEN_HASH` + `FilterHostnameDict` (pure
   hostname dictionary, including type/party-only rules like `||host^$image` —
   those options never set `optionUnitBits`), `ANY/ANY_HTTPS/ANY_HTTP_TOKEN_HASH`
   + `FilterJustOrigin*` (the just-origin dictionary: `*$domain=…` and
   `|http(s|*)://$domain=…`), every other hash a tokenized pattern (one bucket
   per token, reached only when that token appears in the URL), and
   `NO_TOKEN_HASH` (tested on every request). No mirror is involved — this is
   the dispatch surface the engine really probes. A complementary **rule lint**
   classifies every network rule that would land in `NO_TOKEN_HASH`: inherent
   policy (pattern `*`, regex without a tokenizable literal, any scoped option,
   i.e. the origin-scoped `$csp=`/`$permissions=`/`$denyallow=`/`$popup,_3p`
   family uBO must test per request) versus a rewritable defect (a bare
   tokenless pattern such as `*xyz*` with no scoping). Any ENTIRELY rewritable
defect fails the gate — a rule is only allowed to be always-tested when it
    is genuinely uBO-native policy. `src/tokens.js` mirrors the engine's
    token-derivation (pattern runs, `$removeparam` values, regex literals) and
    asserts `BAD_TOKENS` byte-parity with the pinned engine source, so a
    ubo-core bump that re-collates the histogram fails loudly. Current output:
    427,619 of 427,705 units (99.980%) ride the cheap hostname-dict / origin-dict
    / tokenized lanes; the 86 `NO_TOKEN_HASH` units are the 56 origin-scoped
    policy rules (0 rewritable defects).
7. **Cosmetic engine gate** — every `##`/`#@#` line is compiled through the
   vendored uBO `CosmeticFilteringEngine` (the same parser + writer/reader uBO's
   filterset uses). Any line the engine drops — a generic procedural filter under
   the stock `allowGenericProceduralFilters:false` — fails the gate: the build
   pass already removed them, so one reaching Verify means the pipeline and the
   engine disagree on the output. The run also reports the registration metric
   the consumer uBO uses (`getFilterCount()`): units registered vs cosmetic
   lines compiled, accepted and engine-dedup counts, and `0 dropped`.
8. **Cosmetic liveness probes** — a strided sample of host-anchored hides is
   retrieved with the exact `retrieveSpecificSelectors` call uBO makes at
   `webNavigation.onCommitted` (synthetic frame URL, `dontInject:true`, no
   tab). A declarative selector that does not come back in the injected-CSS
   selector list, or a procedural/`:style()` rule whose raw selector is not in
   the engine's procedural output, means the optimizer dropped or reworded it
   and it no longer runs — any miss fails the gate.

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
  retain `trusted-*` scriptlets, `$replace=`, `$uritransform`, `$urlskip`
  (paring with `trustedSource:true`). Because uBO grants trust by URL prefix,
  also add this list's URL to the advanced setting `trustedListPrefixes` or
  the browser will flag those rules invalid at load. Exception rules
  (`#@#+js`, `@@`) are exempt from the trust requirement and always kept.

Browser target is Firefox uBO 1.74+; a Chromium variant would swap the
preprocessor environment tokens and re-run Verify's request-type matrix.

---

## License

MPL-2.0 (this tool and the generated list). The `@gorhill/ubo-core` dependency
used for validation is GPL-3.0 and is only an orchestration-time dependency —
it is not shipped, bundled, or linked into the generated list. Likewise the
vendored uBO cosmetic engine under `vendor/ubo/` is unmodified GPL-3.0
upstream source (pinned in `vendor/ubo/README`, wired to Node solely through
local shims); it is used at build/verify time only and nothing from it is
bundled into `output/StayBrave-Classic.txt`.