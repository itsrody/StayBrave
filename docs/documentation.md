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
lists.toml ──▶ Fetch ──▶ Analyze ──▶ Optimize ──▶ Write
              (fetcher)  (analyzer)  (optimizer)  (writer)
                 │            │           │            │
              concurrent   adblock     dedup +      audit header +
              HTTP +       parse_filter sort         StayBrave.txt
              !#include    validation
              expansion
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| Fetch | `src/fetcher.rs` | Concurrent downloads with a semaphore, timeouts, retries + exponential backoff, redirect limits, and recursive `!#include` expansion. |
| Analyze | `src/analyzer.rs` | Validates every line with `adblock::lists::parse_filter` (rayon-parallel) and classifies results. |
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

[[lists]]
name = "EasyList"
url = "https://easylist.to/easylist/easylist.txt"
enabled = true

[[lists]]
name = "AdGuard Base"
url = "https://filters.adtidy.org/extension/ublock/filters/2.txt"
enabled = true
```

### Fields

- `[fetch]` — all fields optional (documented defaults apply).
- `[output]` — `file` is the default output path (CLI `-o` overrides it).
- `[[lists]]` — an array of sources:
  - `name` (required) — display name used in logs and the output header.
  - `url` (required) — http(s) URL of the raw filter list.
  - `enabled` (optional, default `true`) — set `false` to keep a list in the
    config without fetching it.

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

### 2. Analyze (`src/analyzer.rs`)

Each non-empty line is passed to `adblock::lists::parse_filter` — the same code
Brave's engine uses — and classified:

| Result | Meaning | Output |
| --- | --- | --- |
| `ParsedLine::Network` | Valid network rule | kept |
| `ParsedLine::Cosmetic` | Valid cosmetic rule | kept |
| `Err(Empty)` | Blank/whitespace-only line | skipped |
| `Err(Unsupported)` | Comment, list header, `$$` AdGuard cosmetics, etc. | skipped |
| other `Err(...)` | Rule the engine cannot parse | skipped |

Only rules that parse successfully are written — **the output is guaranteed to
be parseable by the adblock-rust engine.**

### 3. Optimize (`src/optimizer.rs`)

- Exact-duplicate rules (across all sources) are removed via a `HashSet`.
- The remaining rules are sorted byte-wise for a deterministic, diff-able
  output.

### 4. Write (`src/writer.rs`)

The output file starts with a `!`-comment header containing:

- Generation timestamp (UTC).
- Per-source audit line: bytes fetched, included files expanded, line counts,
  network/cosmetic rules, unsupported and invalid counts.
- Global totals: input rules, unique output rules, duplicates removed,
  validated network + cosmetic counts.

---

## Output format

`StayBrave.txt` is a standard filter list:

- Lines beginning with `!` are comments/header (ignored by the engine).
- Every non-comment line is a validated, deduplicated, sorted filter rule.
- Blank lines are not emitted.

### Known behavior / limitations

- **`$popup` rules are dropped.** EasyList contains ~3k `$popup` filters, but
  adblock-rust has no `popup` option (`UnrecognisedOption`); Brave filters
  pop-ups through other machinery. Dropping them keeps the list honest to what
  the engine can enforce.
- **Cosmetic section separators are not written.** Adblock-style `[Section]`
  headers would be parsed as network filters, so sections are intentionally
  omitted; the list is one flat sorted set.
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
