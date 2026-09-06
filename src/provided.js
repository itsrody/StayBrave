// Subtraction of rules already provided by external lists the user enables
// (e.g. uBO's built-in "uBlock filters – Ads", "Badware risks", "Privacy",
// …). When StayBrave-Classic is installed alongside those lists, a rule that
// is textually identical to — or provably covered by — a rule in an enabled
// built-in list is redundant for uBO and is flagged "unused". This module
// drops those rules from our output so every shipped rule is load-bearing,
// while the enabled built-in list keeps supplying the coverage.
//
// Safety: a rule is only dropped when an enabled *provided* list demonstrably
// covers it with the same (or provably stricter) semantics, so blocking is
// never broadened relative to (StayBrave + provided lists).

import { parseSimpleRule } from './network.js';
import {
  isProcedural,
  plainBase,
  registrableDomain,
} from './cosmetic.js';

function locToken(part) {
  const p = part.trim();
  if (p.endsWith('.*')) {
    const base = p.slice(0, -2);
    return { kind: 'entity', value: base.toLowerCase() };
  }
  return { kind: 'host', value: p.toLowerCase() };
}

// Positive host-location tokens for a cosmetic host scope, or undefined when
// the scope cannot participate (negations, wildcards, empties).
function positiveTokens(host) {
  if (host === '') return undefined;
  const out = [];
  for (const p0 of host.split(',')) {
    const p = p0.trim();
    if (p === '') continue;
    if (p.startsWith('~')) return undefined;
    if (!/^[0-9a-zA-Z.\-*]+$/.test(p)) return undefined;
    if (p.includes('*') && !p.endsWith('.*')) return undefined;
    out.push(locToken(p));
  }
  return out.length ? out : undefined;
}

function regOf(host) {
  try {
    return registrableDomain(host);
  } catch {
    return null;
  }
}

function tokenCovers(a, b) {
  if (a.kind === 'any') return true;
  if (a.kind === 'entity' && b.kind === 'host') {
    const domain = regOf(b.value);
    if (domain === null) return false;
    const dot = domain.indexOf('.');
    if (dot === -1) return false;
    const ps = domain.slice(dot + 1);
    if (a.value === ps) return true;
    if (!b.value.endsWith(ps)) return false;
    const wp = b.value.slice(0, b.value.length - ps.length);
    if (wp === '' || !wp.endsWith('.')) return false;
    const w = wp.slice(0, -1);
    return w !== '' && (w === a.value || w.endsWith(`.${a.value}`));
  }
  if (a.kind === 'entity' && b.kind === 'entity') {
    return a.value === b.value || b.value.endsWith(`.${a.value}`);
  }
  if (a.kind === 'host' && b.kind === 'host') {
    if (a.value === b.value) return true;
    if (b.value.length <= a.value.length) return false;
    if (b.value[b.value.length - a.value.length - 1] !== '.') return false;
    return b.value.endsWith(a.value);
  }
  return false;
}

// Does cover set C provably cover victim set V (all of V's tokens are hit)?
// uBO matches cosmetic host scopes by label suffix, so plain `example.com`
// covers `www.example.com` and `example.*` covers any concrete registrable
// host under `example`.
function scopeCovers(C, V) {
  for (const tb of V) {
    if (!C.some((ca) => tokenCovers(ca, tb))) return false;
  }
  return true;
}

// Split a selective rule (`##` plain or `#?#` strong) into host + selector,
// or null for exception/other forms. Strong rules stay selectable as victims
// because a covered plain `##` hide already hides the same elements.
function splitSelective(rule) {
  const strong = rule.indexOf('#?#');
  const plain = rule.indexOf('##');
  if (plain === -1 && strong === -1) return null;
  const marker = strong !== -1 && (plain === -1 || strong < plain) ? '#?#' : '##';
  const idx = rule.indexOf(marker);
  const host = rule.slice(0, idx);
  const selector = rule.slice(idx + marker.length);
  if (selector.startsWith('^') || selector.startsWith('responseheader')) return null;
  return { host, selector, strong: marker === '#?#' };
}

// Index provided cosmetic rules by exact selector -> list of positive scopes.
function indexProvidedCosmetic(provided) {
  const plain = new Map(); // selector -> [scopes]
  const procedural = new Map(); // plainBase -> [scopes]
  for (const rule of provided) {
    const parsed = splitSelective(rule);
    if (parsed === null || parsed.strong) continue;
    const tokens = parsed.host === '' ? [{ kind: 'any' }] : positiveTokens(parsed.host);
    if (tokens === undefined) continue;
    if (isProcedural(parsed.selector)) {
      const base = plainBase(parsed.selector);
      if (base === undefined) continue;
      if (!procedural.has(base)) procedural.set(base, []);
      procedural.get(base).push(tokens);
    } else {
      if (!plain.has(parsed.selector)) plain.set(parsed.selector, []);
      plain.get(parsed.selector).push(tokens);
    }
  }
  return { plain, procedural };
}

export function subtractProvided(ours, provided) {
  const providedSet = new Set(provided);
  const exactRemoved = [];

  // Index provided simple network rules by (lowercased) host suffix.
  const netHosts = new Map(); // lowercase host -> [lowercase path]
  for (const rule of provided) {
    const r = parseSimpleRule(rule);
    if (r === null) continue;
    if (!netHosts.has(r.host.toLowerCase())) netHosts.set(r.host.toLowerCase(), []);
    netHosts.get(r.host.toLowerCase()).push(r.path.toLowerCase());
  }

  const pathCovers = (pa, pb) => pa === '' || pb === pa || pb.startsWith(`${pa}/`);

  const cosIndex = indexProvidedCosmetic(provided);

  const kept = [];
  let networkSubsumed = 0;
  let cosmeticCovered = 0;
  for (const rule of ours) {
    if (providedSet.has(rule)) {
      exactRemoved.push(rule);
      continue;
    }

    // Network: covered by a provided simple `||host...` rule?
    if (!rule.includes('##') && !rule.includes('#?#') && !rule.includes('#@#')) {
      if (rule.includes('$') || rule.includes('*') || rule.includes('@')) {
        kept.push(rule);
        continue;
      }
      const r = parseSimpleRule(rule);
      if (r !== null) {
        const lh = r.host.toLowerCase();
        const lp = r.path.toLowerCase();
        // provide a host covering rule might be a suffix of ours, so search
        // the label-suffix host map keys.
        let covered = false;
        let h = lh;
        while (h !== '') {
          const paths = netHosts.get(h);
          if (paths !== undefined && paths.some((pp) => pathCovers(pp, lp))) {
            covered = true;
            break;
          }
          const i = h.indexOf('.');
          h = i === -1 ? '' : h.slice(i + 1);
        }
        if (covered) {
          networkSubsumed += 1;
          continue;
        }
      }
      kept.push(rule);
      continue;
    }

    // Cosmetic: covered by provided same-selector broader/equal host scope, or
    // a procedural rule covered by a provided plain hide on the same base.
    const parsed = splitSelective(rule);
    if (parsed === null) {
      kept.push(rule);
      continue;
    }
    const vtokens =
      parsed.host === '' ? undefined : positiveTokens(parsed.host);
    if (vtokens === undefined) {
      kept.push(rule);
      continue;
    }
    let covered = false;
    if (isProcedural(parsed.selector)) {
      const base = plainBase(parsed.selector);
      const providedPlain = base === undefined ? undefined : cosIndex.plain.get(base);
      covered =
        providedPlain !== undefined &&
        providedPlain.some((ps) => scopeCovers(ps, vtokens));
    } else {
      const providedPlain = cosIndex.plain.get(parsed.selector);
      covered =
        providedPlain !== undefined &&
        providedPlain.some((ps) => scopeCovers(ps, vtokens));
    }
    if (covered) {
      cosmeticCovered += 1;
      continue;
    }
    kept.push(rule);
  }

  return {
    rules: kept,
    exactRemoved,
    networkSubsumed,
    cosmeticCovered,
  };
}
