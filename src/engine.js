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