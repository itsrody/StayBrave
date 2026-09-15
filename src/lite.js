// MV3 compatibility filter: drop every rule a uBO Lite install cannot execute
// when a subscribed list is compiled into declarativeNetRequest rules at
// runtime. This is the counterpart of uBOL's build-time converter (which logs
// "Salvaged rule" / "Unsupported" per list, see uAssets tools/make-mv3.sh) but
// written as an up-front, counted filter so the shipped file never depends on
// a runtime re-interpretation to be safe.
//
// The policy (matching the pipeline's "never broaden" principle):
//   * entity-wildcard `$domain=` values (`amazon.*`) are dropped together with
//     their whole rule — uBOL ignores entity values at runtime, silently
//     changing the rule's scope, so shipping it would lie to the user;
//   * scriptlets, HTML filters, response-header filters and strong `#?#`
//     cosmetics are dropped (uBOL packages scriptlets at extension-build time
//     only, and a runtime-subscribed list cannot inject JS);
//   * procedural cosmetics (`:has-text`, `:upward`, `:style`, …) are dropped —
//     only plain CSS-hideable selectors (incl. `:has()`, `:not()`) survive;
//   * regex network rules are dropped (DNR caps regex rules at 1000 and RE2
//     rejects most real-world patterns; cleanest to not ship any);
//   * network modifiers uBOL's converter rejects are dropped.
//
// Every kept line was already validated by uBO's own AstFilterParser in the
// analyze stage; this stage runs before optimization so a dropped rule can
// never act as a subsumption cover.

import { splitCosmetic, isProcedural } from './cosmetic.js';

export const liteEmptyStats = () => ({
  total: 0,
  scriptlets: 0,
  html_filters: 0,
  responseheaders: 0,
  strong_cosmetic: 0,
  procedural_cosmetic: 0,
  regex_network: 0,
  entity_domain: 0,
  unsupported_modifiers: 0,
});

// Network modifiers uBO Lite's converter cannot map onto DNR:
//   * `strict1p`/`strict3p` — no DNR equivalent
//   * `ipaddress=` — no DNR action for IP-address filtering
//   * `cname` — CNAME uncloaking has no DNR implementation
//   * `popup` — no DNR concept of popup windows / opener
//   * `replace=` — response-body filtering exists only in Firefox uBO
//   * `uritransform=`/`urlskip=` — trusted-only, no DNR action
//   * `redirect-rule=` — "redirect if blocked" has no DNR equivalent
//   * `genericblock`/`generichide`/`elemhide`/`specifichide`/`uhide`/`shide` —
//     cosmetic-mode switches; if the converter dropped the option the leftover
//     allow rule would broaden blocking
//   * `extsets=` — cosmetic procedural-snippet extension, no DNR/cosmetic CSS
export const LITE_UNSUPPORTED_OPTIONS = new Set([
  'strict1p',
  'strict3p',
  'ipaddress',
  'cname',
  'popup',
  'replace',
  'uritransform',
  'urlskip',
  'redirect-rule',
  'genericblock',
  'generichide',
  'elemhide',
  'specifichide',
  'uhide',
  'shide',
  'extsets',
]);

// Values of these modifiers that cannot be honored even when the option name
// maps cleanly onto DNR.
export function hasUnsupportedModifierValue(opt) {
  const eq = opt.indexOf('=');
  const name = eq === -1 ? opt : opt.slice(0, eq);
  const value = eq === -1 ? '' : opt.slice(eq + 1);
  if (name === 'redirect' && value.includes('click2load')) return true;
  // A regex-valued removeparam (`/^__s=…/`) cannot be ported to DNR.
  if (name === 'removeparam' && value.length > 2 && value.startsWith('/') && value.endsWith('/')) {
    return true;
  }
  return false;
}

// True when a `domain=`/`from=` value carries an entity wildcard (`amazon.*`).
export function hasEntityDomain(opt) {
  const eq = opt.indexOf('=');
  if (eq === -1) return false;
  const name = opt.slice(0, eq);
  if (name !== 'domain' && name !== 'from') return false;
  let value = opt.slice(eq + 1);
  for (const raw of value.split('|')) {
    let p = raw.trim();
    if (p.startsWith('~')) p = p.slice(1);
    if (p.endsWith('.*')) return true;
  }
  return false;
}

// A network regex pattern: `/…/flags` with optional trailing options.
export function isRegexRule(line) {
  return line.startsWith('/') && /^\/.+\/[a-z]*(?:\$|$)/.test(line);
}

function isScriptlet(line) {
  return line.includes('+js(') && (line.includes('##') || line.includes('#@#'));
}

function cosmeticReason(line) {
  if (isScriptlet(line)) return 'scriptlets';
  if (line.includes('^responseheader')) return 'responseheaders';
  if (line.includes('##^') || line.includes('#@#^')) return 'html_filters';
  if (line.includes('#?#') || line.includes('#@?#')) return 'strong_cosmetic';
  const parts = splitCosmetic(line);
  if (parts !== null && isProcedural(parts.selector)) return 'procedural_cosmetic';
  return undefined;
}

function networkReason(line) {
  if (isRegexRule(line)) return 'regex_network';
  const body = line.startsWith('@@') ? line.slice(2) : line;
  const idx = body.lastIndexOf('$');
  if (idx === -1) return undefined;
  // Split honoring backslash-escaped commas inside option values (the same
  // convention rewrite.js uses) so a `\,` in a removeparam/redirect regex is
  // never treated as an option delimiter.
  const parts = [];
  let cur = '';
  for (let i = idx + 1; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      cur += ch + body[i + 1];
      i += 1;
      continue;
    }
    if (ch === ',') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  for (const optRaw of parts) {
    let opt = optRaw;
    if (opt.startsWith('~')) opt = opt.slice(1);
    const eq = opt.indexOf('=');
    const name = eq === -1 ? opt : opt.slice(0, eq);
    if (hasEntityDomain(optRaw)) return 'entity_domain';
    if (LITE_UNSUPPORTED_OPTIONS.has(name)) return 'unsupported_modifiers';
    if (hasUnsupportedModifierValue(optRaw)) return 'unsupported_modifiers';
  }
  return undefined;
}

// Filter a merged rule set through the MV3 compatibility filter. Returns the
// kept lines and a per-category count of what was dropped.
export function stripLite(lines) {
  const stats = liteEmptyStats();
  stats.total = lines.length;
  const kept = [];
  const cosmeticMarker = /##|#\?#|#@#|#@\?#/;
  for (const line of lines) {
    let reason;
    if (cosmeticMarker.test(line)) {
      reason = cosmeticReason(line);
    } else {
      reason = networkReason(line);
    }
    if (reason === undefined) {
      kept.push(line);
      continue;
    }
    stats[reason] += 1;
  }
  return { lines: kept, stats };
}