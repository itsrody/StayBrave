// Engine-certified optimizer recheck.
//
// Our subsumption passes remove network rules they prove dominated. This
// module asks uBO's own StaticNetFilteringEngine to certify each removal: the
// request a removed rule used to block must still be blocked by the surviving
// rules. A rule removed by our optimizer that ends up *not* blocked is a
// coverage hole (a future pass-bug) and must never be shipped.
//
// Rules whose pattern is legitimately cancelled in the merged list (an
// exception such as `@@||host^` unbinds them regardless of subsumption) are
// detected the same engine-truthy way: probing the pre-optimization set shows
// they were never blocking on their own, so no removal took place for them.

import { StaticNetFilteringEngine } from '@gorhill/ubo-core';
import { parseSimpleRule } from './network.js';

const PROBE_LIMIT = 2000;

const TYPE_BY_OPT = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  subdocument: 'subdocument',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  object: 'object',
  'object-subrequest': 'object',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  ping: 'ping',
  other: 'other',
};

// Synthesize the request the removed rule `||host/path^$opts` used to block.
// Returns null for rule shapes the cheap probe cannot exercise (regex/plain
// patterns, non-`||` anchors); those are skipped rather than mis-verified.
export function removedProbe(raw) {
  const idx = raw.indexOf('$');
  const pattern = idx === -1 ? raw : raw.slice(0, idx);
  const simple = parseSimpleRule(pattern);
  if (simple === null) return null;
  const opts = idx === -1 ? [] : raw.slice(idx + 1).split(',').map((o) => o.trim());
  let type = 'script';
  for (const o of opts) {
    if (TYPE_BY_OPT[o] !== undefined) {
      type = TYPE_BY_OPT[o];
      break;
    }
  }
  const scheme = opts.includes('https') && !opts.includes('http') ? 'https' : 'http';
  const token = Math.random().toString(36).slice(2, 10);
  const pathPrefix = simple.path === '' ? '' : simple.path.replace(/\/$/, '') + '/';
  return {
    url: `${scheme}://${simple.host}/${pathPrefix}probe-${token}.js`,
    type,
    originURL: opts.includes('first-party')
      ? `${scheme}://${simple.host}/`
      : `http://origin-${token}.example.net/`,
  };
}

export async function verifyRemovedCoverage(
  preOptLines,
  survivorLines,
  removedNetwork,
  { limit = PROBE_LIMIT } = {}
) {
  // Build the probe queue first (external RNG), spread across the removed set.
  const probeable = [];
  let unprobeable = 0;
  for (const raw of removedNetwork) {
    const probe = removedProbe(raw);
    if (probe === null) {
      unprobeable += 1;
    } else {
      probeable.push({ raw, probe });
    }
  }
  const stride =
    probeable.length > limit ? Math.ceil(probeable.length / limit) : 1;
  const probes = [];
  for (let i = 0; i < probeable.length && probes.length < limit; i += stride) {
    probes.push(probeable[i]);
  }

  const blockedBySurvivor = new Array(probes.length).fill(false);
  const holes = [];
  let maybeHoles = [];
  const engine = await StaticNetFilteringEngine.create();

  try {
    if (survivorLines.length > 0) {
      await engine.useLists([
        { name: 'staybrave-survivors', raw: survivorLines.join('\n') },
      ]);
    }
    for (let i = 0; i < probes.length; i += 1) {
      const { probe } = probes[i];
      const res = await engine.matchRequest(probe);
      blockedBySurvivor[i] = (res & 1) === 1;
    }

    const checked = probes.filter((_, i) => blockedBySurvivor[i] === false);
    maybeHoles = checked;
    if (checked.length > 0) {
      // Re-probe the unblocked subset against the pre-optimization set: if the
      // removed rule itself restored blocking there, its removal lost coverage;
      // if it still does not block, an exception cancelled it (safe to remove).
      await StaticNetFilteringEngine.release();
      await StaticNetFilteringEngine.create();
      await engine.useLists([
        { name: 'staybrave-pre-optimization', raw: preOptLines.join('\n') },
      ]);
      for (const { raw, probe } of maybeHoles) {
        const res = await engine.matchRequest(probe);
        if ((res & 1) === 1) {
          holes.push(raw);
        }
      }
    }
  } finally {
    await StaticNetFilteringEngine.release();
  }

  const verified = probes.length - maybeHoles.length;
  return {
    total: removedNetwork.length,
    sampled: probes.length,
    verified,
    unblocked_safe: maybeHoles.length - holes.length,
    unprobeable,
    holes,
  };
}

// Authoritative evidence gate for the *candidate* superset / dead-block
// removals produced by `subsumeSuperset` / `subsumeDeadByException`. Because
// uBO's domain=-scope and party masking interact in ways a host-suffix
// predicate over-approximates (the engine oracle caught real holes), nothing
// is removed on the predicate's word alone: every candidate is probed against
// the survivor set and only the candidates whose outcome is unchanged by their
// removal are certified.
//
// Crucially the probe set EXCLUDES every candidate rule: a candidate must not
// be allowed to certify itself (with itself present, any self-matching candidate
// would trivially "block" its own probe and the gate would be vacuous). The
// cover relation is transitive and acyclic, so a request a candidate chain
// covers is still directly blocked by the chain's non-candidate maximum —
// probing against non-candidates certifies exactly the provable subset.
//
// Outcome expectations differ by pass:
//   * superset candidates (`subsumeSuperset`): removing the victim must keep
//     the request BLOCKED (a non-candidate survivor still matches it); and
//   * dead-by-exception candidates (`subsumeDeadByException`): the victim was
//     unblocked pre-removal (an exception unbinds it); post-removal the same
//     request must still be UNBLOCKED.
//
// Unlike `verifyRemovedCoverage` (which samples and uses a synthetic third-
// party origin), this gate probes EVERY candidate and, for domain=-scoped
// victims, uses one of the victim's own document hosts as the origin so the
// probe actually exercises the scope the removal would affect.
export async function certifySupersetRemovals(candidateLines, survivorLines, deadByExceptionLines = []) {
  const expectUnblocked = new Set(deadByExceptionLines);
  const probes = [];
  for (const line of candidateLines) {
    const isExc = line.startsWith('@@');
    const body = isExc ? line.slice(2) : line;
    const idx = body.lastIndexOf('$');
    const pattern = idx < 0 ? body : body.slice(0, idx);
    const opts = idx < 0 ? [] : body.slice(idx + 1).split(',').map((o) => o.trim());
    const simple = parseSimpleRule(pattern);
    if (simple === null) continue;
    let type = 'script';
    const typeMap = {
      script: 'script', image: 'image', stylesheet: 'stylesheet',
      subdocument: 'sub_frame', xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
      object: 'object', media: 'media', font: 'font', websocket: 'websocket',
      ping: 'ping', other: 'other', document: 'main_frame', popup: 'popup',
      'object-subrequest': 'object',
    };
    if (opts.includes('document')) type = 'main_frame';
    else if (opts.includes('popup')) type = 'popup';
    else for (const o of opts) if (typeMap[o]) { type = typeMap[o]; break; }

    const scheme = opts.includes('https') && !opts.includes('http') ? 'https' : 'http';
    const token = Math.random().toString(36).slice(2, 10);
    const pp = simple.path === '' ? '' : simple.path.replace(/\/$/, '') + '/';
    const url = `${scheme}://${simple.host}/${pp}probe-${token}.js`;

    // Probes must exercise the scope a removal would affect: for a domain=-
    // scoped victim use its own document hosts as origins (plus a synthetic
    // third-party origin so an unscoped victim is also checked).
    const docHosts = [];
    for (const o of opts) {
      if (o.startsWith('domain=')) {
        for (const d of o.slice(7).split('|').map((x) => x.trim())
          .filter((x) => x && !x.startsWith('~') && !x.includes('*') && /^[0-9a-zA-Z.-]+$/.test(x))) {
          docHosts.push(d.toLowerCase());
        }
      }
    }
    const origins = opts.includes('first-party')
      ? [`${scheme}://${simple.host}/`]
      : docHosts.length > 0
        ? docHosts.map((d) => `http://${d}/`)
        : [`http://origin-${token}.example.net/`];
    for (const originURL of origins) {
      probes.push({ line, probe: { url, type, originURL, tabId: 1, docId: 1, frameId: 0 } });
    }
  }

  // The probe set must not let a candidate certify itself: drop every
  // candidate rule from the survivors before matching.
  const candidateSet = new Set(candidateLines);
  const probeSet = survivorLines.filter((l) => !candidateSet.has(l));

  const engine = await StaticNetFilteringEngine.create();
  let certified = [];
  try {
    if (probeSet.length > 0) {
      await engine.useLists([{ name: 'staybrave-certify-survivors', raw: probeSet.join('\n') }]);
    }
    // A candidate is certified only if every probe on the origins relevant to
    // its scope (its own domain= docs) preserves its pre-removal outcome.
    const perLine = new Map();
    for (const { line, probe } of probes) {
      const res = await engine.matchRequest(probe);
      const blocked = (res & 1) === 1;
      if (!perLine.has(line)) perLine.set(line, { total: 0, okay: 0 });
      const acc = perLine.get(line);
      acc.total += 1;
      const want = expectUnblocked.has(line) ? !blocked : blocked;
      if (want) acc.okay += 1;
    }
    certified = candidateLines.filter((l) => {
      const acc = perLine.get(l);
      return acc !== undefined && acc.okay === acc.total;
    });
  } finally {
    await StaticNetFilteringEngine.release();
  }
  return { certified, candidates: candidateLines };
}