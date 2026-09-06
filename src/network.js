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
  return [kept, removed.size];
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
        continue;
      }
    }
    kept.push(line);
  }
  return [kept, removed];
}

// Approximate distribution across uBO's token buckets (diagnostics only).
// Hostname-anchored rules and single-`$domain` rules are prefiltered out of
// the per-request scan entirely (their durable token comes from the host).
// The residual cost is the catch-all bucket-0 rules: everything left with no
// durable 2+ char run in the filter part (uBO disqualifies the first run of a
// non-anchored rule and the trailing `^`/`$` run of a right-anchored one).
export function tokenBucketEstimate(lines) {
  let hostnameTokened = 0;
  let catchAll = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('!')) continue;
    if (trimmed.includes('##') || trimmed.includes('#?#') || trimmed.includes('#@#')) continue;

    let body = trimmed.startsWith('@@') ? trimmed.slice(2) : trimmed;
    let optsStr = '';
    if (body.lastIndexOf('$') !== -1) {
      optsStr = body.slice(body.lastIndexOf('$') + 1);
      body = body.slice(0, body.lastIndexOf('$'));
    }

    if (body.startsWith('||')) {
      hostnameTokened += 1;
      continue;
    }

    const optNames = optsStr.split(',').map((o) => o.trim()).filter((o) => o !== '');
    if (
      optNames.length === 1 &&
      optNames[0].startsWith('domain=') &&
      !optNames[0].includes('|') &&
      !optNames[0].includes('~') &&
      !optNames[0].includes('*')
    ) {
      hostnameTokened += 1;
      continue;
    }

    const runs = [];
    let cur = 0;
    for (const c of body) {
      if (/[0-9A-Za-z%]/.test(c)) cur += 1;
      else if (cur >= 2) {
        runs.push(cur);
        cur = 0;
      } else cur = 0;
    }
    if (cur >= 2) runs.push(cur);

    const skipFirst = !body.startsWith('/') || body.startsWith('|');
    const dur = runs.filter((_r, i) => (skipFirst ? i > 0 : true));
    if (dur.length > 0) continue;

    catchAll += 1;
  }
  return [hostnameTokened, catchAll];
}