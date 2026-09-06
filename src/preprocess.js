// Abblock-policy directives handled before classification:
//
// * `!#include <url>` — inlined recursively by the fetcher (see fetch.js),
//   the resolver lives here so both paths agree on the syntax.
// * `!#if … !#else … !#endif` — conditional inclusion evaluated against a
//   uBO-compatible environment (desktop Firefox 1.74+). The token truth table
//   mirrors uBO's own preparser token map.

// uBO preparser token -> value the token evaluates as, i.e. an entry of the
// environment value set (uBO's Map above; the value is what is looked up in
// the env array). `false`-mapped tokens are never in a real env.
// See static-filtering-parser.js `preparserTokens`.
const TOKEN_VALUES = {
  ext_ublock: 'ublock',
  ext_ubol: 'ubol',
  ext_devbuild: 'devbuild',
  env_chromium: 'chromium',
  env_edge: 'edge',
  env_firefox: 'firefox',
  env_legacy: 'legacy',
  env_mobile: 'mobile',
  env_mv3: 'mv3',
  env_safari: 'safari',
  cap_html_filtering: 'html_filtering',
  cap_user_stylesheet: 'user_stylesheet',
  cap_ipaddress: 'ipaddress',
  false: 'false',
  ext_abp: 'false',
  adguard: 'adguard',
  adguard_app_android: 'false',
  adguard_app_ios: 'false',
  adguard_app_mac: 'false',
  adguard_app_windows: 'false',
  adguard_ext_android_cb: 'false',
  adguard_ext_chromium: 'chromium',
  adguard_ext_edge: 'edge',
  adguard_ext_firefox: 'firefox',
  adguard_ext_opera: 'chromium',
  adguard_ext_safari: 'false',
};

// Environment value set of a desktop Firefox uBO 1.74+ install.
export const FIREFOX_ENV = new Set([
  'ublock',
  'firefox',
  'html_filtering',
  'user_stylesheet',
]);

export function tokenTruth(exprToken, env = FIREFOX_ENV) {
  let not = false;
  let token = exprToken;
  if (token.startsWith('!')) {
    not = true;
    token = token.slice(1);
  }
  const value = TOKEN_VALUES[token];
  if (value === undefined) {
    return { known: false, truth: false };
  }
  const truth = value !== 'false' && env.has(value);
  return { known: true, truth: not ? !truth : truth };
}

// Evaluate a `!#if` expression: tokens joined by `&&` / `||`, each optionally
// negated or wrapped in parentheses (AdGuard style). Unknown tokens evaluate
// false (mirrors uBO: unknown token is an error and the branch is dropped).
// Returns true when the branch is live.
export function evalIfExpression(expression, env = FIREFOX_ENV) {
  const expr = expression.trim().replace(/^\(|\)$/g, '');
  return expr
    .split('||')
    .map((term) =>
      term
        .split('&&')
        .map((token) => token.trim().replace(/^[([]|[\])]$/g, ''))
        .every((token) => {
          if (token === '') return true;
          const { truth } = tokenTruth(token, env);
          return truth;
        })
    )
    .some((connected) => connected);
}

export const INCLUDE_RE = /^!#include\s+(?:<([^>]+)>|(\S+))/;

export function parseIncludeDirective(line) {
  const m = line.trim().match(INCLUDE_RE);
  if (m === null) return undefined;
  return m[1] ?? m[2];
}

export function isDirective(line) {
  return /^!#(?:if|else|endif|include)\b/.test(line.trim());
}

// Resolve `!#if … !#else … !#endif` blocks. Returns the text with inactive
// branches removed and directive lines stripped. Nested blocks are supported,
// matching abp-policy semantics. Each stack frame records the liveness of its
// current branch so `!#else` never depends on transient global state.
export function expandConditionals(text, env = FIREFOX_ENV) {
  const lines = text.split('\n');
  const out = [];
  const stack = [];
  let active = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('!#if ')) {
      const frame = { parentActive: active };
      const live = evalIfExpression(trimmed.slice('!#if '.length), env);
      frame.curActive = frame.parentActive && live;
      stack.push(frame);
      active = frame.curActive;
      continue;
    }
    if (trimmed === '!#else') {
      const frame = stack.at(-1);
      frame.elseActive = frame.parentActive && !frame.curActive;
      frame.curActive = frame.elseActive;
      active = frame.elseActive;
      continue;
    }
    if (trimmed === '!#endif') {
      const frame = stack.pop();
      active = frame.parentActive;
      continue;
    }
    if (trimmed.startsWith('!#include')) {
      // The fetcher handles include expansion; a raw directive reaching here
      // (fetch disabled) is dropped rather than emitted as a rule.
      continue;
    }
    if (active) out.push(line);
  }

  if (stack.length !== 0) {
    throw new Error('unbalanced !#if/!#endif in list text');
  }
  return out.join('\n');
}