// Cosmetic-rule rewriting and subsumption for Firefox uBlock Origin.
//
// Every decision here targets uBO's actual delivery model:
//
// * Pure-CSS comma lists (`##.a, .b`) are delivered as one native CSS rule —
//   keep them grouped (fewer injected style rules). Lists that contain a
//   procedural/action operator cannot be grouped like that, so they are split
//   first and each piece is rewritten individually.
// * Operators uBO 1.74+ still compiles (`:has-text`, `:matches-css`,
//   `:matches-attr`, `:matches-path`, `:matches-prop`, `:matches-media`,
//   `:min-text-length`, `:upward`, `:xpath`, `:watch-attr`, and the
//   `:style`/`:remove*` actions) are kept; operators that are dead in uBO
//   are rewritten when a live equivalent exists (`:contains`,
//   `:-abp-contains` → `:has-text`, `:nth-ancestor` → `:upward`) and dropped
//   otherwise (`:others`, `:-abp-properties`).
// * Host-scoped subsumption follows uBO's registrable-domain lookup and the
//   entity-probe set, which is the same label-suffix semantics the Rust
//   pipeline verified against adblock-rust. Generic rules never cover
//   host-scoped rules (`$generichide`).

import { parse as parseHost } from 'tldts';

export const OP_HAS_TEXT = ':has-text(';
export const OP_MATCHES_CSS = ':matches-css(';
export const OP_MATCHES_ATTR = ':matches-attr(';
export const OP_MATCHES_PATH = ':matches-path(';

// uBO-executable procedural / action operators.
const EXECUTABLE_OPS = [
  OP_HAS_TEXT,
  OP_MATCHES_CSS,
  OP_MATCHES_ATTR,
  OP_MATCHES_PATH,
  ':matches-prop(',
  ':matches-media(',
  ':min-text-length(',
  ':upward(',
  ':xpath(',
  ':style(',
  ':remove(',
  ':remove-attr(',
  ':remove-class(',
];

// Operators that are dead in uBO with no safe rewrite.
const DROP_OPS = [
  ':others(',
  ':-abp-properties(',
];

// Operators with a live uBO equivalent, rewritten verbatim.
const REWRITE_OPS = [
  [':contains(', OP_HAS_TEXT],
  [':-abp-contains(', OP_HAS_TEXT],
  [':nth-ancestor(', ':upward('],
];

// Operators stripped to compute the plain-CSS base of a procedural selector.
// `:upward`/`:xpath` re-target the matched element and can never be exchanged
// for a plain hide; `:watch-attr` is an observation hook, not a constraint.
const BASE_STRIP_OPS = [
  ...EXECUTABLE_OPS.filter((op) => op !== ':upward(' && op !== ':xpath('),
];

export const CLASS_SEP = '##';

export function containsAny(s, ops) {
  for (const op of ops) if (s.includes(op)) return true;
  return false;
}

// Split `host##selector`, `host#@#selector` into parts. Returns null for
// non-cosmetic lines, `#?#` strong-extended syntax (left to the engine) and
// HTML filters (`##^…`), which must be passed through untouched.
export function splitCosmetic(line) {
  let idx = line.indexOf('#@#');
  if (idx !== -1) {
    return { host: line.slice(0, idx), sep: '#@#', selector: line.slice(idx + 3) };
  }
  idx = line.indexOf('##');
  if (idx === -1) return null;
  const host = line.slice(0, idx);
  if (host.endsWith('?')) return null;
  let selector = line.slice(idx + 2);
  if (selector.startsWith('^') || selector.startsWith('responseheader')) {
    // Extended-HTML / response-headers filters: opaque to these passes.
    return null;
  }
  return { host, sep: CLASS_SEP, selector };
}

export function firstClassIdToken(selector) {
  const first = selector[0];
  if (first !== '.' && first !== '#') return undefined;
  let end = 1;
  for (let i = 1; i < selector.length; i += 1) {
    const c = selector[i];
    if (c === '\\' || c === '-' || c === '_' || /[0-9A-Za-z]/.test(c)) {
      end = i + 1;
    } else {
      break;
    }
  }
  return selector.slice(0, end);
}

export function isProcedural(selector) {
  if (containsAny(selector, [...EXECUTABLE_OPS, ...DROP_OPS])) return true;
  for (const [from] of REWRITE_OPS) if (selector.includes(from)) return true;
  return (
    selector.includes(':remove-attr()') ||
    selector.includes(':remove-class()') ||
    selector.includes(':style()')
  );
}

// Index just past the `)` matching the `(` opened at `open`.
function findClosingParen(s, open) {
  let depth = 0;
  let quote = null;
  let i = open;
  while (i < s.length) {
    const c = s[i];
    if (quote !== null) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  return undefined;
}

function splitTopLevel(s, sep) {
  const pieces = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  let esc = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[') {
      depth += 1;
      continue;
    }
    if (c === ')' || c === ']') {
      depth -= 1;
      continue;
    }
    if (c === sep && depth === 0) {
      pieces.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  pieces.push(s.slice(start).trim());
  return pieces;
}

export function containsTopLevel(s, sep) {
  let depth = 0;
  let quote = null;
  let esc = false;
  for (const c of s) {
    if (esc) {
      esc = false;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === sep && depth === 0) return true;
  }
  return false;
}

// Canonical form of a grouped comma list: trim members and sort them so
// equivalent lists written in different orders deduplicate.
function canonicalizeGrouped(selector) {
  const pieces = splitTopLevel(selector, ',').filter((p) => p !== '');
  if (pieces.length <= 1) return pieces.join(',');
  return [...pieces].sort().join(',');
}

function transformPiece(piece) {
  let sel = piece.trim();
  if (sel === '') return '';

  // `:min-text-length(0)` is inert.
  sel = stripZeroMinTextLength(sel);
  if (sel === '') return '';

  // Dead operators with a live equivalent.
  for (const [from, to] of REWRITE_OPS) {
    const rewritten = rewriteOp(sel, from, to);
    if (rewritten === undefined) return '';
    sel = rewritten;
  }

  // Dead operators with no equivalent.
  if (
    containsAny(sel, DROP_OPS) ||
    sel.includes(':remove-attr()') ||
    sel.includes(':remove-class()') ||
    sel.includes(':style()')
  ) {
    return '';
  }

  // Strip `:style(display:none)` — the engine already applies `display:none`
  // to every `##`-matched element, so the action is redundant. Other style
  // properties are kept.
  while (true) {
    const stripped = stripStyleDisplayNone(sel);
    if (stripped === undefined) break;
    sel = stripped.trim();
  }
  if (sel === '') return '';
  return sel;
}

function rewriteOp(selector, op, replacement) {
  let sel = selector;
  for (;;) {
    const start = sel.indexOf(op);
    if (start === -1) return sel;
    const argStart = start + op.length;
    const argEnd = findClosingParen(sel, argStart);
    if (argEnd === undefined) return undefined;
    const arg = sel.slice(argStart, argEnd);
    if (arg.includes('(') || arg.includes(')')) return undefined;
    sel = sel.slice(0, start) + replacement + arg + ')' + sel.slice(argEnd + 1);
  }
}

function stripZeroMinTextLength(selector) {
  const OP = ':min-text-length(';
  let sel = selector;
  for (;;) {
    const start = sel.indexOf(OP);
    if (start === -1) return sel;
    const argStart = start + OP.length;
    const argEnd = findClosingParen(sel, argStart);
    if (argEnd === undefined) return sel;
    if (sel.slice(argStart, argEnd) !== '0') return sel;
    sel = sel.slice(0, start) + sel.slice(argEnd + 1);
  }
}

function stripStyleDisplayNone(selector) {
  const OP = ':style(';
  const start = selector.indexOf(OP);
  if (start === -1) return undefined;
  const argStart = start + OP.length;
  const argEnd = findClosingParen(selector, argStart);
  if (argEnd === undefined) return undefined;
  const arg = selector.slice(argStart, argEnd).trim().replace(/\s+/g, '').toLowerCase();
  if (arg === 'display:none' || arg === 'display:none!important') {
    return selector.slice(0, start) + selector.slice(argEnd + 1);
  }
  return undefined;
}

export function transformCosmetic(line, opts = { splitCommaLists: false }) {
  const parsed = splitCosmetic(line);
  if (parsed === null) {
    return { lines: [line], commaListsSplit: false };
  }
  const { host, sep, selector } = parsed;

  if (isProcedural(selector)) {
    const lines = [];
    for (const piece of splitTopLevel(selector, ',')) {
      if (piece === '') continue;
      const out = transformPiece(piece);
      if (out === '') continue;
      lines.push(`${host}${sep}${out}`);
    }
    return { lines, commaListsSplit: false };
  }

  if (opts.splitCommaLists) {
    const pieces = splitTopLevel(selector, ',');
    if (pieces.length > 1) {
      const lines = [];
      for (const piece of pieces) {
        if (piece === '') continue;
        lines.push(`${host}${sep}${piece}`);
      }
      if (lines.length > 1) return { lines, commaListsSplit: true };
    }
    return { lines: [line], commaListsSplit: false };
  }

  // Grouped pure-CSS lists are delivered as one native CSS rule in uBO: keep
  // them grouped but canonicalize member ordering so lists written in a
  // different source order deduplicate.
  const canonical = canonicalizeGrouped(selector);
  if (canonical !== selector) {
    return { lines: [`${host}${sep}${canonical}`], commaListsSplit: false };
  }
  return { lines: [line], commaListsSplit: false };
}

// ---------------------------------------------------------------------------
// Delivery-channel classification (reporting only; nothing is dropped here).

export const Channel = {
  SimpleClassId: 0,
  ComplexTokenLed: 1,
  GenericMisc: 2,
  HostnameHide: 3,
  HostnameUnhide: 4,
  Procedural: 5,
};

export function classifyChannel(line) {
  const parsed = splitCosmetic(line);
  if (parsed === null) return undefined;
  const { host, sep, selector } = parsed;
  if (isProcedural(selector)) return Channel.Procedural;
  const hasPositive = host
    .split(',')
    .map((p) => p.trim())
    .some((p) => p !== '' && !p.startsWith('~'));
  if (host === '' || !hasPositive) return classifyGeneric(selector);
  return sep === '#@#' ? Channel.HostnameUnhide : Channel.HostnameHide;
}

function classifyGeneric(selector) {
  const token = firstClassIdToken(selector);
  if (token === undefined) return Channel.GenericMisc;
  return token === selector ? Channel.SimpleClassId : Channel.ComplexTokenLed;
}

export function channelCounts(lines) {
  const counts = new Array(6).fill(0);
  for (const line of lines) {
    const c = classifyChannel(line);
    if (c !== undefined) counts[c] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Location tokens and scope coverage (uBO-safe subsumption).

class LocToken {
  constructor(kind, value) {
    this.kind = kind; // 'host' | 'entity'
    this.value = value;
  }
}

export function registrableDomain(host) {
  try {
    return parseHost(host, { allowPrivateDomains: true }).domain ?? null;
  } catch {
    return null;
  }
}

// A rule token `a` provably covers a rule token `b` under uBO's registrable
// domain + label-suffix lookup: `a` must be a label suffix of `b` that still
// contains `b`'s registrable domain (a public-suffix token is never probed).
function covers(a, b, regOfB) {
  if (a === b) return true;
  if (b.length <= a.length) return false;
  if (!b.endsWith(a)) return false;
  if (b[b.length - a.length - 1] !== '.') return false;
  return regOfB !== null && a.endsWith(regOfB);
}

function entityCoversHost(entity, hostname) {
  const domain = registrableDomain(hostname);
  if (domain === null) return false;
  const dot = domain.indexOf('.');
  if (dot === -1) return false;
  const publicSuffix = domain.slice(dot + 1);
  if (entity === publicSuffix) return true;
  if (!hostname.endsWith(publicSuffix)) return false;
  const withoutPs = hostname.slice(0, hostname.length - publicSuffix.length);
  if (withoutPs === '' || !withoutPs.endsWith('.')) return false;
  const withoutPsClean = withoutPs.slice(0, -1);
  if (withoutPsClean === '') return false;
  return withoutPsClean === entity || withoutPsClean.endsWith(`.${entity}`);
}

function locTokenCovers(a, b, regOfB) {
  if (a.kind === 'entity' && b.kind === 'host') return entityCoversHost(a.value, b.value);
  if (a.kind === 'entity' && b.kind === 'entity') {
    return a.value === b.value || b.value.endsWith(`.${a.value}`);
  }
  if (a.kind === 'host' && b.kind === 'host') return covers(a.value, b.value, regOfB);
  return false; // a full hostname never covers an entity
}

function tokenSetsCover(a, b, reg) {
  for (const tb of b) {
    const regOfB = tb.kind === 'host' ? reg.get(tb.value) ?? null : null;
    if (!a.some((ta) => locTokenCovers(ta, tb, regOfB))) return false;
  }
  return true;
}

// Generic scope covers generic; anything else stays separated ($generichide).
function scopeCovers(cover, victim, reg) {
  if (cover.length === 0 && victim.length === 0) return true;
  if (cover.length === 0 || victim.length === 0) return false;
  return tokenSetsCover(cover, victim, reg);
}

const VALID_LOC_CHAR = /^[0-9a-zA-Z.-]+$/;

// Returns undefined when the host scope cannot participate in subsumption
// (negations, regex or other non-hostname locations): such scopes are opaque.
function positiveLocationTokens(host) {
  if (host === '') return undefined;
  const out = [];
  for (const part0 of host.split(',')) {
    const part = part0.trim();
    if (part === '') continue;
    if (part.startsWith('~')) return undefined;
    const suffix = part.endsWith('.*') ? part.slice(0, -2) : undefined;
    if (suffix !== undefined) {
      if (suffix === '' || !/^[0-9a-zA-Z.-]+$/.test(suffix)) return undefined;
      if (suffix.includes('*')) return undefined;
      out.push(new LocToken('entity', suffix.toLowerCase()));
    } else if (VALID_LOC_CHAR.test(part) && !part.includes('*')) {
      out.push(new LocToken('host', part.toLowerCase()));
    } else {
      return undefined;
    }
  }
  if (out.length === 0) return undefined;
  return out;
}

function buildScopeRegistry(rules) {
  const hosts = new Set();
  for (const rule of rules) {
    if (rule.positives === undefined) continue;
    for (const t of rule.positives) {
      if (t.kind === 'host') hosts.add(t.value);
    }
  }
  const reg = new Map();
  for (const h of hosts) reg.set(h, registrableDomain(h));
  return reg;
}

// ---------------------------------------------------------------------------
// Selector parsing primitives (Pass 2).

const Combinator = {
  NoneOrDescendant: 0,
  Child: 1,
  Sibling: 2,
};

function splitCompounds(selector) {
  const out = [];
  let cur = '';
  let combinator = Combinator.NoneOrDescendant;
  let depth = 0;
  let quote = null;
  let esc = false;

  const flush = () => {
    const text = cur.trim();
    if (text !== '') out.push([combinator, text]);
    cur = '';
  };

  for (const c of selector) {
    if (esc) {
      esc = false;
      cur += c;
      continue;
    }
    if (quote !== null) {
      cur += c;
      if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[') {
      depth += 1;
      cur += c;
      continue;
    }
    if (c === ')' || c === ']') {
      if (depth === 0) return undefined;
      depth -= 1;
      cur += c;
      continue;
    }
    if (c === '>' || c === '+' || c === '~') {
      if (depth === 0) {
        flush();
        combinator = c === '>' ? Combinator.Child : Combinator.Sibling;
      } else {
        cur += c;
      }
      continue;
    }
    if (/\s/.test(c) && depth === 0) {
      flush();
      combinator = Combinator.NoneOrDescendant;
      continue;
    }
    cur += c;
  }
  if (depth !== 0 || quote !== null) return undefined;
  flush();
  if (out.length === 0) return undefined;
  return out;
}

function compoundFeatures(compound) {
  const features = { classes: [], ids: [], hasAttr: false, hasPseudo: false };
  let depth = 0;
  let quote = null;
  let esc = false;
  const chars = [...compound];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    if (esc) {
      esc = false;
      i += 1;
      continue;
    }
    if (quote !== null) {
      if (c === '\\') esc = true;
      else if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '(' || c === '[') {
      if (c === '[' && depth === 0) features.hasAttr = true;
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ')' || c === ']') {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && (c === '.' || c === '#' || c === ':')) {
      if (c === ':') {
        features.hasPseudo = true;
        i += 1;
        continue;
      }
      const start = i;
      i += 1;
      while (
        i < chars.length &&
        (chars[i] === '\\' ||
          chars[i] === '-' ||
          chars[i] === '_' ||
          /[0-9A-Za-z]/.test(chars[i]))
      ) {
        i += 1;
      }
      const token = chars.slice(start + 1, i).join('');
      if (c === '.') features.classes.push(token);
      else features.ids.push(token);
      continue;
    }
    i += 1;
  }
  return features;
}

// Bare selectors that, present as a surviving hide with the same scope, prove
// this selector's targets are hidden.
export function coverCandidates(selector) {
  const compounds = splitCompounds(selector);
  if (compounds === undefined) return [];
  const last = compounds.length - 1;
  const out = [];
  for (let i = 0; i < compounds.length; i += 1) {
    const [_c, text] = compounds[i];
    if (i !== last && compounds.slice(i + 1).some(([c]) => c === Combinator.Sibling)) {
      continue;
    }
    const features = compoundFeatures(text);
    for (const cls of features.classes) out.push(`.${cls}`);
    for (const id of features.ids) out.push(`#${id}`);
    if (!features.hasPseudo && !features.hasAttr) {
      const allTokens = features.classes.length + features.ids.length;
      if (allTokens > 0) {
        const tokens = [
          ...features.classes.map((c) => `.${c}`),
          ...features.ids.map((id) => `#${id}`),
        ].sort();
        if (tokens.length > 1) out.push(tokens.join(''));
        const first = text[0];
        const hasElement = first !== undefined && /[A-Za-z]/.test(first) && first !== '.' && first !== '#';
        if (hasElement) out.push(text.trim());
      }
    }
  }
  return [...new Set(out.sort())];
}

function computeBareCovers(selector) {
  const covers = [];
  const token = firstClassIdToken(selector);
  if (token !== undefined && token === selector) covers.push(token);
  const compounds = splitCompounds(selector);
  if (compounds === undefined) return covers;
  if (compounds.length !== 1) return covers;
  const [[_c, text]] = compounds;
  const features = compoundFeatures(text);
  if (features.hasPseudo || features.hasAttr) return covers;
  const allTokens = features.classes.length + features.ids.length;
  if (allTokens === 0) return covers;
  const first = text[0];
  const hasElement = first !== undefined && /[A-Za-z]/.test(first) && first !== '.' && first !== '#';
  if (!hasElement) {
    const tokens = [
      ...features.classes.map((c) => `.${c}`),
      ...features.ids.map((id) => `#${id}`),
    ].sort();
    covers.push(tokens.join(''));
  } else {
    covers.push(text.trim());
  }
  return [...new Set(covers.sort())];
}

// ---------------------------------------------------------------------------
// Pass 2: channel-aware cosmetic selector subsumption.

export function subsumeSelectors(lines) {
  const rules = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsed = splitCosmetic(line);
    if (parsed === null) continue;
    const { host, sep, selector } = parsed;
    if (isProcedural(selector)) continue;
    const positives = host === '' ? [] : positiveLocationTokens(host);
    rules.push({
      index,
      isHide: sep === CLASS_SEP,
      selector,
      positives,
      bare: computeBareCovers(selector),
    });
  }
  const reg = buildScopeRegistry(rules);
  const removed = new Set();

  const bySelector = new Map();
  for (let idx = 0; idx < rules.length; idx += 1) {
    const key = rules[idx].selector;
    if (!bySelector.has(key)) bySelector.set(key, []);
    bySelector.get(key).push(idx);
  }

  for (;;) {
    let added = false;

    // (A) identical selector, strictly-broader-scope cover.
    for (const rule of rules) {
      if (removed.has(rule.index)) continue;
      const victim = rule.positives;
      if (victim === undefined) continue;
      const idxs = bySelector.get(rule.selector) ?? [];
      for (const oi of idxs) {
        if (removed.has(oi) || oi === rule.index) continue;
        const other = rules[oi];
        if (other.isHide !== rule.isHide) continue;
        const cover = other.positives;
        if (cover === undefined) continue;
        if (scopeCovers(cover, victim, reg) && !scopeCovers(victim, cover, reg)) {
          removed.add(rule.index);
          added = true;
          break;
        }
      }
    }

    // (B) bare-token selector cover.
    const coversByToken = new Map();
    for (const rule of rules) {
      if (removed.has(rule.index)) continue;
      if (!rule.isHide) continue;
      for (const crypt of rule.bare) {
        if (!coversByToken.has(crypt)) coversByToken.set(crypt, []);
        coversByToken.get(crypt).push(rule);
      }
    }
    for (const victim of rules) {
      if (removed.has(victim.index) || !victim.isHide) continue;
      const vp = victim.positives;
      if (vp === undefined) continue;
      for (const token of coverCandidates(victim.selector)) {
        const covers = coversByToken.get(token);
        if (covers === undefined) continue;
        if (
          covers.some(
            (c) =>
              c.index !== victim.index &&
              c.positives !== undefined &&
              scopeCovers(c.positives, vp, reg)
          )
        ) {
          removed.add(victim.index);
          added = true;
          break;
        }
      }
    }

    if (!added) break;
  }

  const kept = lines.filter((_, i) => !removed.has(i));
  return [kept, removed.size];
}

// ---------------------------------------------------------------------------
// Pass 3: procedural subsumption.

export function plainBase(selector) {
  let base = selector;
  for (const op of BASE_STRIP_OPS) {
    for (;;) {
      const start = base.indexOf(op);
      if (start === -1) break;
      const argStart = start + op.length;
      const argEnd = findClosingParen(base, argStart);
      if (argEnd === undefined) return undefined;
      base = base.slice(0, start) + base.slice(argEnd + 1);
    }
  }
  base = base.trim();
  if (base === '' || isProcedural(base)) return undefined;
  return base;
}

const CONSTRAINT_OPS = [
  OP_HAS_TEXT,
  OP_MATCHES_CSS,
  OP_MATCHES_ATTR,
  OP_MATCHES_PATH,
  ':matches-prop(',
  ':matches-media(',
  ':min-text-length(',
  ':style(',
  ':remove(',
  ':remove-attr(',
  ':remove-class(',
];

function extractConstraintOps(selector) {
  return CONSTRAINT_OPS.filter((op) => selector.includes(op)).sort();
}

export function subsumeProcedural(lines) {
  const rules = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const parsed = splitCosmetic(line);
    if (parsed === null) continue;
    const { host, sep, selector } = parsed;
    const positives = host === '' ? [] : positiveLocationTokens(host);
    const procedural = isProcedural(selector);
    rules.push({
      index,
      isHide: sep === CLASS_SEP,
      selector,
      procedural,
      positives,
      base:
        sep === CLASS_SEP && procedural && host !== '' && !host.split(',').some((p) => p.trim().startsWith('~'))
          ? plainBase(selector)
          : undefined,
      constraintOps: procedural ? extractConstraintOps(selector) : [],
    });
  }
  const reg = buildScopeRegistry(rules);
  const removed = new Set();

  const byBase = new Map();
  const bySelector = new Map();
  const plainBySelector = new Map();
  for (let idx = 0; idx < rules.length; idx += 1) {
    const rule = rules[idx];
    if (!bySelector.has(rule.selector)) bySelector.set(rule.selector, []);
    bySelector.get(rule.selector).push(idx);
    if (rule.isHide && !rule.procedural) {
      if (!plainBySelector.has(rule.selector)) plainBySelector.set(rule.selector, []);
      plainBySelector.get(rule.selector).push(idx);
    }
    if (rule.base !== undefined) {
      if (!byBase.has(rule.base)) byBase.set(rule.base, []);
      byBase.get(rule.base).push(idx);
    }
  }

  for (;;) {
    let added = false;

    // (i) plain hide over procedural variant, same plain-CSS base.
    for (const victim of rules) {
      if (removed.has(victim.index) || !victim.isHide) continue;
      const vp = victim.positives;
      const base = victim.base;
      if (vp === undefined || base === undefined) continue;
      const idxs = plainBySelector.get(base) ?? [];
      for (const oi of idxs) {
        if (removed.has(oi) || oi === victim.index) continue;
        const other = rules[oi];
        const cp = other.positives;
        if (cp === undefined) continue;
        if (scopeCovers(cp, vp, reg)) {
          removed.add(victim.index);
          added = true;
          break;
        }
      }
    }

    // (ii) identical procedural selector, broader scope.
    for (const victim of rules) {
      if (removed.has(victim.index)) continue;
      const vp = victim.positives;
      if (vp === undefined) continue;
      const idxs = bySelector.get(victim.selector) ?? [];
      for (const oi of idxs) {
        if (removed.has(oi) || oi === victim.index) continue;
        const other = rules[oi];
        if (!other.procedural || !victim.procedural) continue;
        if (other.isHide !== victim.isHide) continue;
        const cp = other.positives;
        if (cp === undefined) continue;
        if (scopeCovers(cp, vp, reg) && !scopeCovers(vp, cp, reg)) {
          removed.add(victim.index);
          added = true;
          break;
        }
      }
    }

    // (iii) constraint-count subsumption.
    for (const victim of rules) {
      if (removed.has(victim.index) || !victim.procedural || !victim.isHide) continue;
      const vp = victim.positives;
      const base = victim.base;
      if (vp === undefined || base === undefined) continue;
      const idxs = byBase.get(base) ?? [];
      for (const oi of idxs) {
        if (removed.has(oi) || oi === victim.index) continue;
        const other = rules[oi];
        if (!other.procedural || !other.isHide) continue;
        if (other.isHide !== victim.isHide) continue;
        if (other.constraintOps.length >= victim.constraintOps.length) continue;
        if (!other.constraintOps.every((op) => victim.constraintOps.includes(op))) continue;
        const cp = other.positives;
        if (cp === undefined) continue;
        if (scopeCovers(cp, vp, reg)) {
          removed.add(victim.index);
          added = true;
          break;
        }
      }
    }

    if (!added) break;
  }

  const kept = lines.filter((_, i) => !removed.has(i));
  return [kept, removed.size];
}