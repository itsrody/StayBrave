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
| Optimize | `src/optimizer.rs` | Removes exact duplicates and sorts deterministically. |
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
./target/release/staybrave                     # uses lists.toml, writes StayBrave.txt
./target/release/staybrave --config lists.toml # explicit config path
./target/release/staybrave -o out.txt          # override output path
./target/release/staybrave --help
```

| Flag | Default | Description |
| --- | --- | --- |
| `-c, --config` | `lists.toml` | Path to the TOML config describing the lists to fetch. |
| `-o, --output` | `StayBrave.txt` (from config) | Output file path. |

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
file = "StayBrave.txt"

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

- Exact-duplicate rules (across all sources) are removed via a `HashSet`.
- The remaining rules are sorted byte-wise for a deterministic, diff-able
  output.

### 5. Write (`src/writer.rs`)

The output file starts with a `!`-comment header containing:

- Generation timestamp (UTC).
- Per-source audit line: bytes fetched, included files expanded, line counts,
  network/cosmetic rules, unsupported, invalid, hosts-converted, scriptlet and
  redirect counts, and unrecognized-option/unsupported-cosmetic counts.
- Global totals: input rules, unique output rules, duplicates removed,
  validated network + cosmetic counts, filtered scriptlet + redirect counts,
  and normalization/elimination totals.

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
