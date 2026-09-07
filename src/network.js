// Subsumption of simple network rules for Firefox uBlock Origin.
//
// uBO matches `||host^` / `||host/path^` rules against the request hostname by
// label-suffix probing (the SNFE `hostname-suffixes` trie) and the right `^`
// against the first `/`, `?`, `#` boundary. The same two facts the Rust
// pipeline relied on therefore hold here:
//
// * a rule whose hostname is a *label suffix* of another's is broader, and
// * on the same host, a `/`-boundary prefix path is broader.
//
// Both relations are transitive, so a single greedy pass over rules sorted by
// `(host.len, path.len)` (longest cover first) yields the maximal set.
//
// Test probes against `@gorhill/ubo-core` SNFE pin the uBO-specific edges:
//
// * an optionless `||host/path^` blocks `document`, `subdocument`, `script`,
//   … but **not** `popup` — so `$popup` rules are never subsumed by an
//   optionless counterpart (adblock-rust defaulted it the other way).
// * `$badfilter` cancels its exact base rule; both leave the list before
//   subsumption so a dead rule can never act as a covering rule.
// * `$domain=example.*` wildcard TLDs are *not* an error in uBO's parser —
//   they stay in the output (dropping would broaden blocking) and are only
//   counted for diagnostics.

export function parseSimpleRule(raw) {
  if (raw.includes('*') || raw.includes('$') || raw.includes('@')) return null;
  if (!raw.startsWith('||')) return null;
  let body = raw.slice(2);
  let terminator;
  if (body.endsWith('^')) {
    body = body.slice(0, -1);
    terminator = '^';
  } else if (body.endsWith('/')) {
    body = body.slice(0, -1);
    terminator = '/';
  } else {
    return null;
  }
  let host;
  let path;
  const slash = body.indexOf('/');
  if (slash === -1) {
    host = body;
    path = '';
  } else {
    host = body.slice(0, slash);
    path = body.slice(slash + 1);
  }
  if (
    host === '' ||
    !/^[0-9a-z.\-]+$/.test(host)
  ) {
    return null;
  }
  return { raw, host, path, terminator };
}

function pathPrefixCovers(pa, pb) {
  return pa === '' || pb === pa || pb.startsWith(`${pa}/`);
}

function labelSuffixes(host) {
  const out = [];
  let h = host;
  while (h !== '') {
    out.push(h);
    const i = h.indexOf('.');
    h = i === -1 ? '' : h.slice(i + 1);
  }
  return out;
}

// Remove `$badfilter` cancellation pairs. Both the `$badfilter` rule and the
// base rule it cancels (same pattern, same remaining options) are dropped.
function stripBadfilterPairs(lines) {
  const cancelled = new Map();
  for (const line of lines) {
    const idx = line.lastIndexOf('$');
    if (idx === -1) continue;
    const opts = line.slice(idx + 1).split(',');
    if (!opts.includes('badfilter')) continue;
    const remaining = opts.filter((o) => o !== 'badfilter').join(',');
    const pattern = line.slice(0, idx);
    if (!cancelled.has(pattern)) cancelled.set(pattern, new Set());
    cancelled.get(pattern).add(remaining);
  }
  if (cancelled.size === 0) return lines;

  return lines.filter((line) => {
    const idx = line.lastIndexOf('$');
    if (idx === -1) {
      return !(cancelled.get(line)?.has('') ?? false);
    }
    const opts = line.slice(idx + 1).split(',');
    if (opts.includes('badfilter')) return false;
    const optsStr = opts.join(',');
    const pattern = line.slice(0, idx);
    return !(cancelled.get(pattern)?.has(optsStr) ?? false);
  });
}

// Greedy, order-safe subsumption of `||host^` / `||host/path^` block rules.
export function subsume(lines) {
  const stripped = stripBadfilterPairs(lines);
  const rules = [];
  for (let i = 0; i < stripped.length; i += 1) {
    const r = parseSimpleRule(stripped[i]);
    if (r !== null) rules.push([r, i]);
  }
  rules.sort((a, b) => {
    const ra = a[0];
    const rb = b[0];
    return (
      ra.host.length - rb.host.length ||
      ra.path.length - rb.path.length ||
      rb.terminator.localeCompare(ra.terminator)
    );
  });

  const keptByHost = new Map();
  const removed = new Set();

  for (const [rule, index] of rules) {
    const lhost = rule.host.toLowerCase();
    const lpath = rule.path.toLowerCase();
    const covered = labelSuffixes(lhost).some((suffix) => {
      const paths = keptByHost.get(suffix);
      return (
        paths !== undefined &&
        paths.some((p) => pathPrefixCovers(p, lpath))
      );
    });
    if (covered) {
      removed.add(index);
    } else {
      if (!keptByHost.has(lhost)) keptByHost.set(lhost, []);
      keptByHost.get(lhost).push(lpath);
    }
  }

  const kept = stripped.filter((_, i) => !removed.has(i));
  const removedLines = [];
  for (let i = 0; i < stripped.length; i += 1) {
    if (removed.has(i)) removedLines.push(stripped[i]);
  }
  return [kept, removed.size, removedLines];
}

export function countWildcardDomainRules(lines) {
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes('##') || trimmed.includes('#?#') || trimmed.includes('#@#')) continue;
    const idx = trimmed.lastIndexOf('$');
    if (idx === -1) continue;
    const opts = trimmed.slice(idx + 1);
    if (opts.split(',').some((opt) => {
      const name = opt.trim().replace(/^domain=/, '');
      if (!opt.trim().startsWith('domain=')) return false;
      return name.split('|').some((d) => {
        const dd = d.trim();
        return dd.endsWith('.*') || dd.startsWith('~') && dd.endsWith('.*');
      });
    })) count += 1;
  }
  return count;
}

const SUBSUMABLE_OPTIONS = new Set([
  'script',
  'image',
  'stylesheet',
  'object',
  'object-subrequest',
  'media',
  'subdocument',
  'ping',
  'xmlhttprequest',
  'xhr',
  'websocket',
  'font',
  'other',
  'http',
  'https',
  'third-party',
  'first-party',
]);

// Drop `pattern$opts` rules strictly covered by an optionless `pattern`.
// `$document`, `$popup`, `$important`, `$redirect`, `$domain`, `$badfilter`
// and structural modifiers are never subsumed (uBO's optionless mask does not
// include the document/popup navigation types, and the others are directives).
export function subsumeScoped(lines) {
  const optionless = new Set(
    lines.filter((l) => !l.includes('$'))
  );
  const kept = [];
  const removedLines = [];
  let removed = 0;
  for (const line of lines) {
    const idx = line.lastIndexOf('$');
    if (idx === -1) {
      kept.push(line);
      continue;
    }
    const pattern = line.slice(0, idx);
    if (optionless.has(pattern)) {
      const opts = line.slice(idx + 1).split(',');
      const dominated = opts.every((o) => {
        const t = o.trim();
        return (t.startsWith('~') && SUBSUMABLE_OPTIONS.has(t.slice(1))) ||
          SUBSUMABLE_OPTIONS.has(t);
      });
      if (dominated) {
        removed += 1;
        removedLines.push(line);
        continue;
      }
    }
    kept.push(line);
  }
  return [kept, removed, removedLines];
}

// uBO's optionless network mask (from SNFE defaults): document/popup/webrtc
// are NOT covered by a bare `||host^` — they need their explicit options.
export const OPTIONLESS_TYPES = new Set([
  'subdocument',
  'script',
  'image',
  'stylesheet',
  'object',
  'object-subrequest',
  'media',
  'xmlhttprequest',
  'font',
  'ping',
  'websocket',
  'other',
]);

// Approximate distribution across uBO's token buckets (diagnostics only),
// mirroring `StaticNetFilteringEngine.freeze`: each network rule is stored
// under the token derived from its pattern (`FilterCompiler.makeToken`), which
// yields exactly three cost classes:
//
//   tokened    — bucket keyed by a real URL token (`||` hostname and pattern
//                rules with a durable 2+ char run): visited only when the
//                request host/path contains the token.
//   justOrigin — `*`/`http(s)://` patterns whose only option is `domain=`:
//                stored as FilterJustOrigin units behind the ANY/HTTP/HTTPS
//                token hashes — visited on every request, but the domain is
//                trie-checked.
//   catchAll   — the NO_TOKEN bucket: rules whose pattern exposes no durable
//                2+ char run (`*$script`, negated-only patterns, …); every
//                request evaluates them in full.
export function tokenBucketEstimate(lines) {
  let tokened = 0;
  let justOrigin = 0;
  let catchAll = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('!')) continue;
    if (trimmed.includes('##') || trimmed.includes('#?#') || trimmed.includes('#@#')) continue;

    let body = trimmed.startsWith('@@') ? trimmed.slice(2) : trimmed;
    let pattern = body;
    let opts = [];
    if (body.lastIndexOf('$') !== -1) {
      pattern = body.slice(0, body.lastIndexOf('$'));
      opts = body.slice(body.lastIndexOf('$') + 1).split(',');
    }
    if (pattern.includes('#')) { catchAll += 1; continue; }

    const onlyDomain =
      opts.length > 0 &&
      opts.every((o) => {
        const t = o.trim();
        if (t.startsWith('~')) return false;
        const name = t.indexOf('=') === -1 ? t : t.slice(0, t.indexOf('='));
        return name === 'domain' || name === 'from';
      });
    // A pattern-less rule compiles to the same just-origin unit as `*`.
    const effective = pattern === '' ? '*' : pattern;
    if (effective === '*') {
      if (onlyDomain) { justOrigin += 1; continue; }
      catchAll += 1;
      continue;
    }
    if (
      (effective.startsWith('|http://') || effective.startsWith('|https://')) &&
      onlyDomain
    ) {
      justOrigin += 1;
      continue;
    }

    if (patternIncludesDurableRun(effective)) {
      tokened += 1;
      continue;
    }
    catchAll += 1;
  }
  return [tokened, justOrigin, catchAll];
}

const RUN = /[0-9A-Za-z%]{2,}/g;
function patternIncludesDurableRun(pattern) {
  RUN.lastIndex = 0;
  let m;
  while ((m = RUN.exec(pattern)) !== null) {
    const bef = m.index === 0 ? '' : pattern[m.index - 1];
    const aft = m.index + m[0].length < pattern.length ? pattern[m.index + m[0].length] : '';
    if (bef !== '*' && aft !== '*') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Superset block subsumption (candidate only — ENGINE-CERTIFIED by the caller).
//
// A block `v` (host/path + type masks + party + domain scope) is a *candidate*
// for removal when a surviving block `c` provably covers the same requests:
//
//   * host: `c` host is an equal/label-suffix of `v`'s and spans the same path
//     (an optionless suffix cover must span all of `v`'s paths; on the same
//     host a path-prefix cover suffices); and
//   * types: `c` type mask ⊇ `v` type mask, where an optionless `||host^` is
//     the OPTIONLESS_TYPES mask (it does not cover document/popup, so a
//     `$document`/`$popup` victim is never covered by an optionless survivor);
//   * party: `c` is `both` or equals `v`'s single party, and
//   * scope: `c`'s domain scope ⊇ `v`'s, and `c` must be truly scope-covering
//     (a bare `||host^` covers all documents, a `domain=`-scoped survivor does
//     not cover an unscoped victim).
//
// This pass is deliberately PERMISSIVE (it may over-report): the pipeline's
// engine-recheck probes every candidate against the survivor set and only the
// subset the engine *certifies still blocks* is actually removed. That makes
// the shipped removals provable-by-construction instead of trusting this
// predicate, which the engine oracle has shown to over-approximate on
// domain=-scoped / party-masked interactions.
const NET_TYPES = new Set([
  'script',
  'image',
  'stylesheet',
  'object',
  'object-subrequest',
  'media',
  'subdocument',
  'ping',
  'xmlhttprequest',
  'xhr',
  'websocket',
  'font',
  'other',
  'document',
  'popup',
]);
const SUPERSET_SKIP_OPTS = new Set([
  'important',
  'redirect',
  'redirect-rule',
  'csp',
  'removeparam',
  'urlskip',
  'uritransform',
  'replace',
  'denyallow',
  'generichide',
  'badfilter',
  'all',
  'cname',
  'ipaddress',
]);

function normNetOpts(opts) {
  const types = [];
  let party = 'both';
  let scope = null; // array of lowered domains when domain=/from= present
  for (const o0 of opts) {
    const o = o0.trim();
    if (o === '') continue;
    if (NET_TYPES.has(o)) {
      types.push(o === 'xhr' ? 'xmlhttprequest' : o);
      continue;
    }
    if (o === 'first-party') {
      party = party === 'third-party' ? 'both' : 'first-party';
      continue;
    }
    if (o === 'third-party') {
      party = party === 'first-party' ? 'both' : 'third-party';
      continue;
    }
    if (o.startsWith('~')) return null;
    if (o.startsWith('domain=') || o.startsWith('from=')) {
      const v = o.slice(o.indexOf('=') + 1);
      if (v.includes('~')) return null;
      const toks = v
        .split('|')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t !== '');
      if (toks.length === 0) continue;
      scope = scope === null ? toks : scope.concat(toks);
      continue;
    }
    return null;
  }
  let typesUnique = [...new Set(types)].sort();
  if (typesUnique.includes('xmlhttprequest') && typesUnique.includes('xhr')) {
    typesUnique = typesUnique.filter((t) => t !== 'xhr');
  }
  return {
    types: typesUnique,
    party,
    scope: scope === null ? null : [...new Set(scope)].sort(),
  };
}

function netTypeMask(n) {
  return n.types.length === 0 ? OPTIONLESS_TYPES : new Set(n.types);
}

function netPathCovers(pa, pb) {
  return pa === '' || pb === pa || pb.startsWith(`${pa}/`);
}

function netHostCovers(a, b) {
  // a covers b when equal host with path-prefix, or a is a label-suffix host
  // that spans all of b's paths (any path on the suffixed host).
  if (a.h === b.h) {
    return b.p === '' ? a.p === '' : a.p === '' || netPathCovers(a.p, b.p);
  }
  if (b.h.length <= a.h.length) return false;
  if (!b.h.endsWith(a.h)) return false;
  if (b.h[b.h.length - a.h.length - 1] !== '.') return false;
  return a.p === '';
}

// Strict superset (the victim is genuinely implied — never identical).
function netCovers(c, v) {
  if (!netHostCovers(c, v)) return false;
  const mc = netTypeMask(c);
  const mv = netTypeMask(v);
  for (const t of mv) if (!mc.has(t)) return false;
  if (c.party !== 'both' && c.party !== v.party) return false;
  if (c.scope === null) {
    // survivor applies on all documents: covers any narrower scope.
  } else if (v.scope === null) {
    return false; // victim on all documents, survivor only some
  } else {
    // survivor must block on every document the victim does.
    const cs = new Set(c.scope);
    if (!v.scope.every((t) => cs.has(t))) return false;
  }
  // require strict difference somewhere
  const sameTypes = c.types.length === v.types.length &&
    c.types.every((t) => v.types.includes(t));
  const sameHost = c.h === v.h && c.p === v.p;
  const sameParty = c.party === v.party;
  const sameScope = c.scope === null ? v.scope === null : c.scope.join('|') === v.scope.join('|');
  return !(sameHost && sameTypes && sameParty && sameScope);
}

function isSupersetEligibleLine(line) {
  if (line.startsWith('@@')) return null;
  const i = line.lastIndexOf('$');
  const pattern = i < 0 ? line : line.slice(0, i);
  const opts = i < 0 ? [] : line.slice(i + 1).split(',');
  if (opts.some((o) => {
    const t = o.trim();
    return SUPERSET_SKIP_OPTS.has(t) ||
      (NET_TYPES.has(t) === false &&
        t.startsWith('first-') === false &&
        t.startsWith('third-') === false &&
        t.startsWith('domain=') === false &&
        t.startsWith('from=') === false &&
        t !== '');
  })) return null;
  const s = parseSimpleRule(pattern);
  if (s === null) return null;
  const n = normNetOpts(opts);
  if (n === null) return null;
  return {
    line,
    h: s.host.toLowerCase(),
    p: s.path.toLowerCase(),
    types: n.types,
    party: n.party,
    scope: n.scope,
  };
}

function netLabelSuffixes(host) {
  const out = [];
  let h = host;
  while (true) {
    out.push(h);
    const i = h.indexOf('.');
    if (i === -1) break;
    h = h.slice(i + 1);
    if (!h.includes('.')) break; // stop before a bare public-suffix bucket
  }
  return out;
}

// Returns [candidateRemovals(as lines), affectedBlocks] — the caller gates the
// candidate list through the engine before removing anything.
export function subsumeSuperset(lines) {
  // Two indexes keep this tractable:
  //   * exact-host buckets (equal-host path-prefix covers), and
  //   * suffix buckets holding ONLY empty-path rules (a suffix cover must span
  //     all of the victim's paths), keyed by the victim's own later labels so
  //     bare public-suffix buckets never blow up.
  const byExactHost = new Map();
  const byCoverSuffix = new Map();
  const parsed = [];
  let skipped = 0;

  for (const line of lines) {
    const p = isSupersetEligibleLine(line);
    if (p === null) {
      skipped += 1;
      continue;
    }
    parsed.push(p);
    if (!byExactHost.has(p.h)) byExactHost.set(p.h, []);
    byExactHost.get(p.h).push(p);
    if (p.p === '') {
      for (const sfx of netLabelSuffixes(p.h)) {
        if (!byCoverSuffix.has(sfx)) byCoverSuffix.set(sfx, []);
        byCoverSuffix.get(sfx).push(p);
      }
    }
  }

  const candidate = new Set();
  for (const victim of parsed) {
    // (1) equal-host covers: a same-host rule with path='' or a path-prefix
    // precedes the victim's path.
    const sameHost = byExactHost.get(victim.h);
    if (sameHost !== undefined) {
      for (const cover of sameHost) {
        if (cover.line === victim.line) continue;
        if (netCovers(cover, victim)) {
          candidate.add(victim.line);
          break;
        }
      }
    }
    if (candidate.has(victim.line)) continue;

    // (2) suffix covers: only empty-path covers reach a victim whose own host
    // is deeper, so scan the victim's label suffixes.
    const suffixes = netLabelSuffixes(victim.h);
    for (const sfx of suffixes) {
      const bucket = byCoverSuffix.get(sfx);
      if (bucket === undefined) continue;
      for (const cover of bucket) {
        if (cover.h === victim.h) continue; // handled in (1)
        if (netCovers(cover, victim)) {
          candidate.add(victim.line);
          break;
        }
      }
      if (candidate.has(victim.line)) break;
    }
  }

  return {
    removed_lines: [...candidate].sort(),
    parsed_count: parsed.length,
    skipped_count: skipped,
  };
}

// Dead-block candidates: a block whose requests an exception already unbinds
// across every document where the block applies. Candidate-only for the same
// engine-certification gate. An exception covers `v` when it shares the exact
// host (or a label-suffix host spanning all paths), matches every type of `v`,
// matches `v`'s party, and its scope ⊇ `v`'s scope (an unscoped exception
// covers anything). Only `||`-shaped simple blocks are considered.
export function subsumeDeadByException(lines) {
  const blocks = [];
  const exceptions = [];
  for (const line of lines) {
    const isExc = line.startsWith('@@');
    const body = isExc ? line.slice(2) : line;
    const i = body.lastIndexOf('$');
    const pattern = i < 0 ? body : body.slice(0, i);
    const opts = i < 0 ? [] : body.slice(i + 1).split(',');
    if (opts.some((o) => {
      const t = o.trim();
      return SUPERSET_SKIP_OPTS.has(t) ||
        (NET_TYPES.has(t) === false &&
          t.startsWith('first-') === false &&
          t.startsWith('third-') === false &&
          t.startsWith('domain=') === false &&
          t.startsWith('from=') === false &&
          t !== '');
    })) continue;
    const s = parseSimpleRule(pattern);
    if (s === null) continue;
    const n = normNetOpts(opts);
    if (n === null) continue;
    (isExc ? exceptions : blocks).push({
      line,
      h: s.host.toLowerCase(),
      p: s.path.toLowerCase(),
      types: n.types,
      party: n.party,
      scope: n.scope,
    });
  }

  const candidate = new Set();
  for (const b of blocks) {
    for (const e of exceptions) {
      if (netExceptionCovers(e, b)) {
        candidate.add(b.line);
        break;
      }
    }
  }

  return {
    removed_lines: [...candidate].sort(),
  };
}

// Dead network-exception candidates: a `@@` whitelist rule that suppresses NO
// block in the merged set (no block is reachable by host/path AND compatible
// by type/party/scope). Such an exception can never change a request outcome —
// it is inert weight the engine still indexes. Candidate-only: the engine gate
// (`certifyDeadExceptionRemovals`) probes each candidate with the exception
// removed and only certifies those whose removal provably changes nothing.
//
// Blocks are indexed the same way `subsumeSuperset` indexes covers
// (exact-host buckets + label-suffix buckets), but here EVERY block goes into
// the suffix buckets regardless of path: a pathless exception also reaches a
// deeper host's path-prefixed rule (`@@||example.com^` unbinds
// `||www.example.com/ads^`), so the predicate must see those too.
export function subsumeDeadExceptions(lines) {
  const exceptions = [];
  const parseNetLike = (line) => {
    const body = line.startsWith('@@') ? line.slice(2) : line;
    const i = body.lastIndexOf('$');
    const opts = i < 0 ? [] : body.slice(i + 1).split(',');
    if (opts.some((o) => {
      const t = o.trim();
      return SUPERSET_SKIP_OPTS.has(t) ||
        (NET_TYPES.has(t) === false &&
          t.startsWith('first-') === false &&
          t.startsWith('third-') === false &&
          t.startsWith('domain=') === false &&
          t.startsWith('from=') === false &&
          t !== '');
    })) return null;
    const s = parseSimpleRule(i < 0 ? body : body.slice(0, i));
    if (s === null) return null;
    const n = normNetOpts(opts);
    if (n === null) return null;
    return {
      line,
      h: s.host.toLowerCase(),
      p: s.path.toLowerCase(),
      types: n.types,
      party: n.party,
      scope: n.scope,
    };
  };

  for (const line of lines) {
    if (line.startsWith('@@') === false) continue;
    if (line.includes('#')) continue;
    const parsed = parseNetLike(line);
    if (parsed !== null) exceptions.push(parsed);
  }

  const byExactHost = new Map();
  const byCoverSuffix = new Map();
  for (const line of lines) {
    if (line.startsWith('@@') || line.includes('#')) continue;
    const b = parseNetLike(line);
    if (b === null) continue;
    if (!byExactHost.has(b.h)) byExactHost.set(b.h, []);
    byExactHost.get(b.h).push(b);
    for (const sfx of netLabelSuffixes(b.h)) {
      if (!byCoverSuffix.has(sfx)) byCoverSuffix.set(sfx, []);
      byCoverSuffix.get(sfx).push(b);
    }
  }

  const dead = [];
  for (const e of exceptions) {
    let reachable = false;
    const sameHost = byExactHost.get(e.h);
    if (sameHost !== undefined) {
      for (const b of sameHost) {
        if (netExceptionCovers(e, b)) {
          reachable = true;
          break;
        }
      }
    }
    if (reachable === false) {
      for (const sfx of netLabelSuffixes(e.h)) {
        const bucket = byCoverSuffix.get(sfx);
        if (bucket === undefined) continue;
        for (const b of bucket) {
          if (b.h === e.h) continue;
          if (netExceptionCovers(e, b)) {
            reachable = true;
            break;
          }
        }
        if (reachable) break;
      }
    }
    if (reachable === false) dead.push(e.line);
  }

  return { removed_lines: [...new Set(dead)].sort() };
}

// Exception coverage: same host-reach as a block cover, plus the exception's
// type mask must cover the block's (an optionless `@@||host^` unbinds every
// type incl. document/popup — exceptions are not limited to OPTIONLESS_TYPES),
// party matches, and scope ⊇.
function netExceptionCovers(e, v) {
  // host reach: equal host with path-prefix over, or label-suffix host
  // spanning all of the victim's paths.
  if (e.h === v.h) {
    if (e.p !== '' && !netPathCovers(e.p, v.p)) return false;
  } else {
    if (v.h.length <= e.h.length || !v.h.endsWith(e.h)) return false;
    if (v.h[v.h.length - e.h.length - 1] !== '.') return false;
    if (e.p !== '') return false;
  }
  // types: an exception's mask must cover the victim's mask, but a bare
  // exception (no type options) is unbind-all.
  if (e.types.length !== 0) {
    const mv = new Set(v.types.length === 0 ? OPTIONLESS_TYPES : v.types);
    for (const t of mv) if (!e.types.includes(t)) return false;
  }
  if (e.party !== 'both' && e.party !== v.party) return false;
  if (e.scope === null) {
    // exception applies on all documents
  } else if (v.scope === null) {
    return false;
  } else {
    // The exception must unbind every document the block applies on,
    // otherwise dropping the block unblocks it elsewhere: e.scope ⊇ v.scope.
    const es = new Set(e.scope);
    if (!v.scope.every((t) => es.has(t))) return false;
  }
  return true;
}