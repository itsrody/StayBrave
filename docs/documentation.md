# StayBrave

**StayBrave** is a Rust command-line tool that fetches, analyzes, validates, and
optimizes Adblock-Plus-style filter lists (EasyList, EasyPrivacy, uBlock Origin
filters, AdGuard, etc.) into a single, deduplicated, sorted `StayBrave.txt`
filter list.

Every rule in the output is validated by the **exact same parser** that powers
Brave's native adblocker — the [`adblock`](https://crates.io/crates/adblock)
Rust crate (adblock-rust). If a rule survives the pipeline, the Brave engine can
parse it.

---

## Why Rust?

- **Accuracy by construction** — the tool links the real `adblock` crate, so
  rules are parsed with Brave's own `adblock::lists::parse_filter`. There is no
  hand-rolled parser to drift out of sync with the browser engine.
- **Throughput** — tokio async I/O downloads lists concurrently; rayon parses
  the (often ~150k-line) lists in parallel across CPU cores.
- **Zero runtime dependencies** — ships as a single static binary.

---

## Pipeline

```
lists.toml ──▶ Fetch ──▶ Normalize ──▶ Analyze+Filter ──▶ Optimize ──▶ Write
              (fetcher) (normalizer)  (analyzer/filter) (optimizer)  (writer)
                 │            │               │              │            │
              concurrent   hosts→||^,    adblock         dedup +      audit header +
              HTTP +       $empty/$mp4,  parse_filter    sort         StayBrave.txt
              !#include    redirect      validation
              expansion    canonicalization
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| Fetch | `src/fetcher.rs` | Concurrent downloads with a semaphore, timeouts, retries + exponential backoff, redirect limits, and recursive `!#include` expansion. |
| Normalize | `src/normalizer.rs` | Translates cross-family syntax into engine-compatible rules: hosts lines to `||domain^`, uBO `$empty`/`$mp4` shorthands to `$redirect`, and uBO/ABP redirect aliases to canonical resource names. |
| Analyze | `src/analyzer.rs` | Validates every line with `adblock::lists::parse_filter` (rayon-parallel) and classifies results into named statistics buckets. |
| Filter | `src/filter.rs` | Drops rules referencing functionality the Brave engine cannot execute (uBO scriptlets, unlisted `$redirect` resources). |
| Optimize | `src/optimizer.rs` | Removes exact duplicates, sorts deterministically, applies proven network/cosmetic subsumption and the cosmetic cost passes (comma-list split, Pass 2/3 subsumption), and reports channel/token-bucket diagnostics. |
| Write | `src/writer.rs` | Emits `StayBrave.txt` with a full provenance/statistics header. |
| Config | `src/config.rs` | Typed deserialization of `lists.toml`. |

---

## Building

Requires Rust 1.70+ (developed against 1.94).

```sh
cargo build --release
```

The binary is produced at `target/release/staybrave`.

## Usage

```sh
./target/release/staybrave                     # uses lists.toml, writes output/StayBrave.txt
./target/release/staybrave --config lists.toml # explicit config path
./target/release/staybrave -o out.txt          # override output path
./target/release/staybrave --help
```

| Flag | Default | Description |
| --- | --- | --- |
| `-c, --config` | `lists.toml` | Path to the TOML config describing the lists to fetch. |
| `-o, --output` | `output/StayBrave.txt` (from config) | Output file path. |

Log level can be tuned with `RUST_LOG` (e.g. `RUST_LOG=debug ./target/release/staybrave`).

---

## Configuration (`lists.toml`)

```toml
[fetch]
concurrency = 16          # max parallel HTTP requests
timeout_secs = 30         # per-request timeout
retries = 2               # retries after transient/5xx failures
retry_delay_ms = 500      # initial backoff (doubles per retry)
max_redirects = 5
expand_includes = true    # resolve !#include directives
max_include_depth = 4     # recursion limit for nested includes
user_agent = "StayBrave/0.1 (filter-list optimizer)"

[output]
file = "output/StayBrave.txt"

[filter]                          # optional; defaults match Brave's supported set
scriptlets = true                 # strip uBO +js()/script:inject rules
redirect_allowlist = [            # canonical $redirect resource names that are kept
  "1x1.gif", "noop.js", "empty", "google-ima.js",
]

[[lists]]
name = "EasyList"
url = "https://easylist.to/easylist/easylist.txt"
enabled = true

[[lists]]
name = "StevenBlack hosts"
url = "https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts"
enabled = true
hosts = true                     # treat as a hosts file, not adblock syntax
```

### Fields

- `[fetch]` — all fields optional (documented defaults apply).
- `[output]` — `file` is the default output path (CLI `-o` overrides it).
- `[filter]` — all fields optional:
  - `scriptlets` (default `true`) — drop uBO scriptlet-injection cosmetic rules
    (`##+js(...)`, `#@#+js(...)`, `##script:inject(...)`). The adblock-rust
    parser accepts them but Brave cannot execute scriptlets, so they are dead
    weight.
  - `redirect_allowlist` (default: the canonical no-op/media/google resource
    names adblock-rust/Brave ships) — `$redirect`/`$redirect-rule`/`$rewrite`
    rules referencing any resource not in this list are dropped, since they can
    never resolve to a real redirect. Values are compared after
    canonicalization (uBO aliases like `noopjs` → `noop.js`, `abp-resource:`
    prefixes stripped).
  - `cosmetic_cost` — all fields optional (default `true` each):
    - `split_comma_lists` — split pure-CSS `##.a, .b` comma lists into
      individual rules (fixes the engine's first-token cosmetic keying bug).
    - `subsume_selectors` — Pass 2: remove cosmetic rules provably covered by a
      broader-scope same-selector rule or a cheaper bare-token generic rule.
    - `subsume_procedural` — Pass 3: remove procedural rules covered by a plain
      rule on the same base selector, and de-duplicate procedural variants
      across host scopes.
- `[[lists]]` — an array of sources:
  - `name` (required) — display name used in logs and the output header.
  - `url` (required) — http(s) URL of the raw filter list.
  - `enabled` (optional, default `true`) — set `false` to keep a list in the
    config without fetching it.
  - `hosts` (optional, default `false`) — when `true`, the list is treated as
    hosts-file syntax: `#`/`!` comments are dropped, and IP-led or bare-domain
    lines become `||domain^` network rules. Required for lists such as
    StevenBlack/hosts, whose comments would otherwise be misparsed as bogus
    literal-substring filters.

---

## How it works

### 1. Fetch (`src/fetcher.rs`)

- Only `enabled` lists are fetched.
- A `Semaphore` bounds concurrency to `fetch.concurrency`.
- Failed/5xx responses retry up to `fetch.retries` times with exponential
  backoff; other HTTP statuses fail immediately.
- Responses are decoded lossily to UTF-8 (filter lists occasionally contain
  stray bytes).

**`!#include` expansion** — uBlock Origin and AdGuard lists assemble large
lists from `!#include <file>` directives. The fetcher:

- Resolves **relative** include URLs against the including file's URL
  (e.g. `!#include filters-2023.txt` inside
  `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt`
  resolves to `.../filters/filters-2023.txt`).
- Detects include **cycles** and enforces `max_include_depth`.
- Unresolvable or failed includes are replaced by a `! StayBrave: ...` comment
  (and logged), so nothing is silently lost.

### 2. Normalize (`src/normalizer.rs`)

Before parsing, every line passes through a small translator that maps
cross-family syntax to rules the engine understands. Every translated line is
then re-parsed by the real engine, so a rewrite can never silently change
semantics — if the rewritten text does not parse, it is simply dropped.

- **Hosts files** (lists with `hosts = true`): `#`/`!` comments are dropped and
  IP-led lines (`0.0.0.0 example.com evil.com`) expand to `||example.com^`,
  `||evil.com^`. Localhost aliases (`localhost`, `ip6-*`, `broadcasthost`) are
  skipped. This is required because the parser would otherwise misread
  `0.0.0.0 example.com` as a literal-substring network filter.
- **uBO shorthands**: `$empty` → `$redirect=empty`, `$mp4` →
  `$redirect=noop-1s.mp4`.
- **Redirect alias canonicalization**: `$redirect`/`$redirect-rule`/`$rewrite`
  resource values are mapped to canonical names — `noopjs` → `noop.js`,
  `noopmp4-1s` → `noop-1s.mp4`, `abp-resource:blank-mp4` → `noop-1s.mp4`,
  etc. — so the allowlist only ever needs canonical names.
- Everything else passes through unchanged.

### 3. Analyze + Filter (`src/analyzer.rs`, `src/filter.rs`)

Each non-empty line is passed to `adblock::lists::parse_filter` — the same code
Brave's engine uses — and classified:

| Result | Meaning | Output |
| --- | --- | --- |
| `ParsedLine::Network` | Valid network rule | kept (unless filter drops it) |
| `ParsedLine::Cosmetic` | Valid cosmetic rule | kept (unless filter drops it) |
| `Err(Empty)` | Blank/whitespace-only line | skipped |
| `Err(Unsupported)` | Comment, list header, `$$` AdGuard cosmetics, etc. | skipped |
| other `Err(...)` | Rule the engine cannot parse | skipped |

Only rules that parse successfully are written — **the output is guaranteed to
be parseable by the adblock-rust engine.**

Rules that parse but are **unsupported at runtime** are then dropped by the
filter layer:

- **uBO scriptlet injection** — cosmetic rules carrying the engine's
  `SCRIPT_INJECT` flag (`##+js(...)`, `#@#+js(...)`) or the legacy
  `script:inject(...)` selector. The engine parses these as cosmetic filters
  but has no scriptlet runtime to execute them, so they would never run in a
  browser.
- **Unlisted `$redirect` / `$redirect-rule` / `$rewrite` resources** — any
  redirect rule whose (canonicalized) resource name is absent from
  `filter.redirect_allowlist` (default: the canonical no-op/media/google
  resource names adblock-rust/Brave ships). Without a matching resource the
  rule can never redirect, so it is removed.

Filtered counts are reported per source in the output header, together with
three more named buckets: hosts entries converted, and network options /
cosmetic syntax the engine does not recognize (AdGuard `$cookie`, `$stealth`,
`$sitekey`, `$csp`, `#$#`/`#%#` inline scriptlets, `$$` response filters, ...).

### 4. Optimize (`src/optimizer.rs`)

After deduplication and a deterministic byte-wise sort:

- **Network subsumption** (`src/network.rs`) — option-less block rules
  (`||host^`, `||host/path^`) are parsed into host/path parts and sorted by
  length so broader rules are always decided first. A rule is dropped when a
  kept rule covers it: same-host `host/`, `/path/`-boundary prefixes, or a
  parent path covering a child path. `$`-option rules, exceptions (`@@`),
  regex/`*` patterns, and `$domain`-restricted rules are opaque and untouched.
- **Bare-host caret preservation** — `||host^` and `||host/` subsume
  identically for sub-resources, but they are *different rules*: in adblock-rust
  a hostname-anchored, right-anchored rule with no content-type options is
  given an implicit `FROM_ALL_TYPES` mask, so `||host^` also blocks top-level
  Document navigations while `||host/` does not. When the two coincide, the
  `^` form is kept as the survivor. No `||host^` → `||host/` conversion is ever
  performed: the `^` is not a regex (it is compiled to the right-anchor flag),
  and rewriting would silently drop navigation blocking.
- **Cosmetic subsumption** (`src/cosmetic.rs`) — among host-scoped plain-CSS
  rules with an identical selector and kind, a narrower host scope is dropped
  when a broader one covers it (subdomain families share the engine's
  hostname-probe channel). Entity locations (`example.*`) participate as
  *covers*: the engine's entity probe set (label suffixes of the registrable
  domain plus the bare public suffix) is broader than any full hostname, so
  `example.*##.ad` covers `example.com##.ad`, `www.example.co.uk##.ad`, etc.
  A full hostname never covers an entity. Negated locations (`~x`, `~x.*`) and
  procedural selectors stay opaque.
- **Cosmetic cost passes** (`src/cosmetic.rs`, gated by `[filter.cosmetic_cost]`
  in `lists.toml`, all default-on). These only remove rules that are provably
  covered by another (surviving) rule:
  - `split_comma_lists` — pure-CSS `##.a, .b, .c` comma lists are split into
    individual rules. The engine keys cosmetic rules on the first class/id
    token only (`cosmetic_filter_utils.rs`), so an unsplit list is delivered in
    full only when `.a` is present; splitting fixes that routing bug and
    improves match precision.
  - `subsume_selectors` (Pass 2) — two provable cover rules, iterated to a
    fixpoint so a rule is removed only when its cover also survives: (A) an
    identical selector on a strictly-broader scope covers (same channel kind);
    (B) a bare class/id selector covers a costlier descendant selector in the
    *generic* channel (e.g. `##.ad` removes `##div.ad`, `.ad .x`, `[data-ad]`
    attribute targets) — the generic engine only materializes rules for
    present classes, so the two are label-identity-equal. Ancestor compounds
    behind sibling combinators (`.ad + .x`) are never considered covers, and
    `$generichide`/host-scoped rules are opaque to generic covers in both
    directions.
  - `subsume_procedural` (Pass 3) — generic `:has-text`/`:matches-css` etc.
    never survive parsing in adblock-rust (`filters/cosmetic.rs` rejects
    `GenericAction`), so every procedural rule is host-scoped. Pass 3 removes
    a procedural rule when (i) the same `plain_base` selector exists as a
    non-procedural hide with a scope that covers it (`##.ad` removes
    `example.com##.ad:has-text(x)`), or (ii) an identical procedural selector
    exists on a strictly-broader scope. Procedural exceptions (`#@#…:has-text`)
    never participate, and exception pruning applies only to exactly-equal
    selector strings.
- **Tokenizer diagnostics** — the optimizer reports how final network rules
  distribute across the engine's token buckets: hostname-tokened rules (cheap
  prefilter) vs. catch-all bucket-0 rules that are checked on *every*
  request, plus a count of AdGuard wildcard-TLD `$domain=….*` rules (kept in
  the output — dropping one would broaden blocking — but noted because the
  engine hashes such values verbatim and they never actually match). Final
  cosmetic rules are also binned into the engine's delivery channels
  (simple class/id, complex token-led, generic-misc, hostname-hide,
  hostname-unhide, procedural) so heavy rules are visible.

### 5. Write (`src/writer.rs`)

The output file starts with the ABP-standard `[Adblock Plus 2.0]` marker and a
metadata header (`! Title`, `! Version`, `! Description`, `! Expires`,
`! Homepage`, `! Last modified`) so adblock managers can display the list and
schedule updates, followed by a `!`-comment provenance/statistics header with:

- Generation timestamp (UTC).
- Per-source audit line: bytes fetched, included files expanded, line counts,
  network/cosmetic rules, unsupported, invalid, hosts-converted, scriptlet and
  redirect counts, and unrecognized-option/unsupported-cosmetic counts.
- Global totals: input rules, unique output rules, duplicates removed, cosmetic
  rules subsumed (Pass 2), procedural rules subsumed (Pass 3), network rules
  subsumed, rewritten, semantic duplicates merged, wildcard-TLD `$domain`
  rules, the estimated token-bucket split (hostname-tokened vs. catch-all
  network rules), and the cosmetic channel distribution (simple class/id,
  complex token-led, generic-misc, hostname-hide, hostname-unhide,
  procedural), plus validated network/cosmetic counts and filtered scriptlet +
  redirect counts.

The `Title`, `Description`, `Expires`, and `Homepage` values come from the
`[output]` section of `lists.toml`; `Version` is the generation timestamp
(EasyList-style `YYYYMMDDHHMM`), so every build is monotonic.

---

## Output format

`StayBrave.txt` is a standard filter list:

- Lines beginning with `!` are comments/header (ignored by the engine).
- Every non-comment line is a validated, deduplicated, sorted filter rule.
- Blank lines are not emitted.

### Known behavior / limitations

- **Rules using engine-unknown options are dropped.** adblock-rust rejects
  options such as `$popup`, `$sitekey`, `$cookie`, `$stealth`, `$csp`,
  `$inline-script`, and `$strict1p` (`UnrecognisedOption`); such rules are
  eliminated and counted as unsupported options. Dropping them keeps the list
  honest to what the engine can enforce.
- **Cosmetic section separators are not written.** Adblock-style `[Section]`
  headers would be parsed as network filters, so sections are intentionally
  omitted; the list is one flat sorted set.
- **uBO scriptlet injection rules are dropped.** `##+js(...)`,
  `#@#+js(...)`, and `##script:inject(...)` rules are parsed as cosmetic
  filters but cannot be executed by the engine, so they are filtered out (see
  `[filter]`).
- **Deduplication is exact-text**, not semantic. The engine's `Engine`
  internally normalizes equivalent rules at load time; a `.txt` list cannot do
  better.
- **Wildcard-TLD `$domain=….*` rules never match.** adblock-rust 0.13 hashes
  `$domain` values verbatim and has no wildcard-TLD support for *network*
  filters (the `entity.*` wildcard exists only for cosmetic locations). Such
  rules are kept (dropping one would broaden blocking) and counted in the
  header, but they are inert.
- **`||host^` is preferred over `||host/`** for the same bare host — the `^`
  form additionally blocks top-level document navigations (see Optimize above).

---

## Verification (`examples/`)

Two runnable harnesses rebuild Brave's engine from artifacts and prove the
pipeline does not change blocking behavior:

```sh
# Requests the optimizer claims are redundant, probed across a request-type
# matrix (other/script/image/stylesheet/xhr/media/font/object/ping/websocket/
# sub_frame/document). Also gates every bare `||host^` rule: it must block a
# top-level document navigation to its host.
cargo run --release --example verify -- output/StayBrave.txt

# Before/after engine equivalence over cosmetic hosts, generic class/id
# selectors, and the network request-type matrix for every rewritten,
# subsumed, or sampled rule. Fails on any blocking/exception/redirect mismatch.
cargo run --release --example equivalence -- output/StayBrave.txt
```

`VERIFY_SAMPLE`, `VERIFY_BASELINE_RULES`, `EQ_MAX_HOSTS`, and `EQ_MAX_NET_URLS`
tune the sampling sizes.

---

## Extending

- **Binary `.dat` output** — the "fully optimized" format Brave actually loads.
  Build an engine and serialize it:

  ```rust
  let mut fs = adblock::lists::FilterSet::new(false);
  fs.add_filter_list(text, ParseOptions::default());
  let engine = adblock::engine::Engine::new_with_filter_set(fs);
  let dat = engine.serialize();
  ```

- **Regional lists** — append `[[lists]]` entries for your region.
- **List tags / categories** — `lists.toml` previously exposed a `tags` array;
  re-introduce it to support selective fetches by category.

---

## License

MPL-2.0
