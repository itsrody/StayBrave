// Per-source analysis: normalize every line, run uBO compatibility rewriting,
// classify with uBO's own AstFilterParser, and hand the parser-direct handle
// to the shared module-level parser. Every kept line has already been verified
// error-free against the parser the shipped engine extends.

import {
  makeParser,
  parseLine,
  AST_ERROR,
  isTrustedScriptletToken,
} from './ubo.js';
import { transformCosmetic } from './cosmetic.js';
import { normalizeHostsLine, normalizeLine } from './normalize.js';
import { expandConditionals } from './preprocess.js';

// The trusted flag is a parser-mode, not a per-line property: with
// `trustedSource: false` (the shipped default) trusted-syntax rules carry
// AST_ERROR_UNTRUSTED_SOURCE and are dropped here.
export function emptyStats() {
  return {
    total_lines: 0,
    network_rules: 0,
    cosmetic_rules: 0,
    scriptlets: 0,
    html_filters: 0,
    responseheaders: 0,
    empty: 0,
    unsupported: 0,
    invalid: 0,
    scriptlets_removed: 0,
    hosts_converted: 0,
    unsupported_options: 0,
    unsupported_cosmetic: 0,
    cosmetic_transforms: 0,
    comma_lists_split: 0,
  };
}

function scriptletToken(raw) {
  const m = raw.match(/#\+js?\(([^),\s]+)/);
  return m === null ? '' : m[1];
}

function isHostScopeHost(host) {
  if (host === '') return false;
  return host
    .split(',')
    .every((p) => p.trim() !== '' && !p.trim().startsWith('~'));
}

// A single `AstFilterParser` instance is created per filter-list analysis (or
// shared across all sources by the pipeline — uBO itself reuses one parser
// instance over its whole asset set: `parse()` rewinds the node pool and
// zeroes every node field, so no state leaks between lines).
export function analyzeText(text, filter, isHosts, parser) {
  const stats = emptyStats();
  if (parser === undefined) {
    parser = makeParser({ keep_trusted_only: filter.keep_trusted_only });
  }
  const lines = [];

  const expanded = expandConditionals(text);
  for (const raw0 of expanded.split('\n')) {
    stats.total_lines += 1;
    const trimmed = raw0.trim();
    if (trimmed === '') {
      stats.empty += 1;
      continue;
    }

    const normalized = isHosts
      ? normalizeHostsLine(trimmed)
      : normalizeLine(trimmed);
    if (normalized.hostsConverted) stats.hosts_converted += 1;
    if (normalized.lines.length === 0) {
      stats.unsupported += 1;
      continue;
    }

    for (const candidate of normalized.lines) {
      const transformed = transformCosmetic(candidate, {
        splitCommaLists: filter.cosmetic_cost.split_comma_lists,
      });
      if (transformed.commaListsSplit) stats.comma_lists_split += 1;
      if (transformed.lines.length !== 1 || transformed.lines[0] !== candidate) {
        stats.cosmetic_transforms += 1;
        if (transformed.lines.length === 0) stats.unsupported_cosmetic += 1;
      }
      for (const line of transformed.lines) {
        const kept = classify(line, filter, parser, stats);
        if (kept !== undefined) lines.push(kept);
      }
    }
  }
  return { lines, stats };
}

function classify(line, filter, parser, stats) {
  const parsed = parseLine(parser, line);
  if (!parsed.ok) {
    const unsupportedKinds = [
      AST_ERROR.OPTION_UNKNOWN,
      AST_ERROR.UNTRUSTED_SOURCE,
      AST_ERROR.OPTION_DUPLICATE,
    ];
    if (unsupportedKinds.some((bit) => parsed.error & bit)) {
      stats.unsupported_options += 1;
    } else {
      stats.invalid += 1;
    }
    return undefined;
  }

  switch (parsed.kind) {
    case 'network': {
      stats.network_rules += 1;
      return line;
    }
    case 'cosmetic': {
      if (parsed.strong) {
        // `#?#` strong-selector rules are passed to the engine untouched.
      }
      stats.cosmetic_rules += 1;
      return line;
    }
    case 'scriptlet': {
      if (filter.scriptlets !== true) {
        stats.scriptlets_removed += 1;
        return undefined;
      }
      const host = cosmeticHost(line);
      if (!isHostScopeHost(host)) {
        stats.scriptlets_removed += 1;
        return undefined;
      }
      const token = scriptletToken(line);
      if (isTrustedScriptletToken(token) && filter.keep_trusted_only !== true) {
        stats.scriptlets_removed += 1;
        return undefined;
      }
      stats.scriptlets += 1;
      return line;
    }
    case 'html': {
      stats.html_filters += 1;
      return line;
    }
    case 'responseheader': {
      stats.responseheaders += 1;
      return line;
    }
    default:
      stats.unsupported += 1;
      return undefined;
  }
}

function cosmeticHost(line) {
  const idx = Math.max(line.indexOf('#@#'), line.indexOf('##'));
  if (idx === -1) return '';
  return line.slice(0, idx);
}