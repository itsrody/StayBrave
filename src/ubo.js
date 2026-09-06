// Thin glue around uBlock Origin's own static-filter-parser so that every
// classification and validity decision in the pipeline is made by the exact
// parser Firefox uBO 1.74+ ships, rather than by a hand-rolled grammar.

import {
  AstFilterParser,
} from '@gorhill/ubo-core/js/static-filtering-parser.js';

export const AST_ERROR = {
  NONE: 1, // exported value is 1<<0
  REGEX: 2,
  PATTERN: 4,
  DOMAIN_NAME: 8,
  OPTION_DUPLICATE: 16,
  OPTION_UNKNOWN: 32,
  OPTION_BADVALUE: 64,
  OPTION_EXCLUDED: 128,
  IF_TOKEN_UNKNOWN: 256,
  UNTRUSTED_SOURCE: 512,
};

export const AST_FLAG = {
  UNSUPPORTED: 1,
  IGNORE: 2,
  HAS_ERROR: 4,
  IS_EXCEPTION: 8,
  EXT_STRONG: 16,
  HAS_OPTIONS: 2048,
};

// astType / astTypeFlavor numeric values (see static-filtering-parser.js iotas).
export const AST_TYPE = {
  NONE: 0,
  UNKNOWN: 1,
  COMMENT: 2,
  NETWORK: 3,
  EXTENDED: 4,
  COMMENT_PREPARSER: 5,
  NETWORK_PATTERN_ANY: 0,
  NETWORK_PATTERN_HOSTNAME: 1,
  NETWORK_PATTERN_PLAIN: 2,
  NETWORK_PATTERN_REGEX: 3,
  EXTENDED_COSMETIC: 6,
  EXTENDED_SCRIPTLET: 7,
  EXTENDED_HTML: 8,
  EXTENDED_RESPONSEHEADER: 9,
};

// Scriptlet tokens that uBO treats as trusted (they are inert unless the list
// is added to uBO's trustedListPrefixes). Every current trusted scriptlet is
// `trusted-` prefixed; the set is kept explicit so a future prefix change is
// obvious in one place. The parser flags these only when the embedder passes
// a `trustedScriptletTokens` set, which ubo-core never does, so we mirror the
// check here against the scriptlet token extracted from the raw line.
export const TRUSTED_SCRIPTLET_TOKENS = new Set([
  'trusted-click-element',
  'trusted-replace-fetch-response',
  'trusted-replace-property',
  'trusted-replace-xhr-response',
  'trusted-set-attr',
  'trusted-set-attr-value',
  'trusted-set-constant',
  'trusted-sha1',
]);

export function isTrustedScriptletToken(token) {
  return token.startsWith('trusted-');
}

export function makeParser({ keep_trusted_only = false, trustedScriptletTokens = TRUSTED_SCRIPTLET_TOKENS } = {}) {
  // `interactive: true` activates scriptlet/selector argument validation and
  // the trusted-scriptlet check; `trustedSource: true` keeps $replace,
  // $urlskip, $uritransform and trusted-scriptlet rules parseable when the
  // operator explicitly asked to keep trusted-only syntax. The parser flags a
  // scriptlet token that is in `trustedScriptletTokens` whenever
  // `trustedSource` is false — the same enforcement uBO applies to lists a
  // normal browser adds without trusting them.
  return new AstFilterParser({
    interactive: true,
    trustedSource: keep_trusted_only,
    trustedScriptletTokens,
  });
}

export function parseLine(parser, raw) {
  // `result.error` is written by the embedded ExtSelectorCompiler whenever a
  // cosmetic selector fails to compile — errors astError does not flag (e.g.
  // `.bad{selector}`) — and is never cleared between parse() calls, so reset
  // it here to read only the current line's verdict.
  parser.result.error = undefined;
  parser.parse(raw);
  const flags = parser.astFlags;
  let kind;
  // Classification through the parser's own predicates matches exactly how the
  // filter compiler partitions lines inside the shipped engine.
  if (parser.isNetworkFilter()) {
    kind = 'network';
  } else if (parser.isExtendedFilter()) {
    if (parser.isCosmeticFilter()) kind = 'cosmetic';
    else if (parser.isScriptletFilter()) kind = 'scriptlet';
    else if (parser.isHtmlFilter()) kind = 'html';
    else if (parser.isResponseheaderFilter()) kind = 'responseheader';
    else kind = 'extended-other';
  } else if (
    parser.isComment() ||
    parser.astType === AST_TYPE.UNKNOWN ||
    parser.astType === AST_TYPE.NONE
  ) {
    kind = 'comment-or-unknown';
  } else {
    kind = 'other';
  }
  return {
    raw,
    ok: (flags & AST_FLAG.HAS_ERROR) === 0,
    kind,
    flavor: parser.astTypeFlavor,
    exception: (flags & AST_FLAG.IS_EXCEPTION) !== 0,
    unsupported: (flags & AST_FLAG.UNSUPPORTED) !== 0,
    error: parser.astError,
    options: (flags & AST_FLAG.HAS_OPTIONS) !== 0,
    strong: (flags & AST_FLAG.EXT_STRONG) !== 0,
    selectorError: parser.result.error,
  };
}

export function errorName(error) {
  const names = Object.entries(AST_ERROR)
    .filter(([k, v]) => (error & v) !== 0 && k !== 'NONE')
    .map(([k]) => k)
    .sort();
  return names.length === 0 ? 'NONE' : names.join('|');
}