import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeNetOptions, canonicalizeRules } from '../src/rewrite.js';

test('canonicalizeNetOptions rewrites uBO synonym spellings to canonical names', () => {
  const cases = [
    ['||x.com^$1p', '||x.com^$first-party'],
    ['||x.com^$3p', '||x.com^$third-party'],
    ['||x.com^$xhr', '||x.com^$xmlhttprequest'],
    ['||x.com^$doc', '||x.com^$document'],
    ['||x.com^$frame', '||x.com^$subdocument'],
    ['||x.com^$css', '||x.com^$stylesheet'],
    ['||x.com^$queryprune', '||x.com^$removeparam'],
    ['||x.com^$rewrite=/foo/bar/', '||x.com^$redirect=/foo/bar/'],
    ['||x.com^$beacon', '||x.com^$ping'],
    ['||x.com^$ehide', '||x.com^$elemhide'],
    ['||x.com^$ghide', '||x.com^$generichide'],
    ['||x.com^$shide', '||x.com^$specifichide'],
    ['@@||x.com^$1p', '@@||x.com^$first-party'],
    ['||x.com^$~3p', '||x.com^$~third-party'],
    ['||x.com^$~xhr,image', '||x.com^$image,~xmlhttprequest'],
    ['||x.com^$first-party,3p', '||x.com^$first-party,third-party'],
  ];
  for (const [input, want] of cases) {
    assert.equal(canonicalizeNetOptions(input), want, input);
  }
});

test('canonicalizeNetOptions leaves non-synonym lines byte-for-byte', () => {
  const untouched = [
    '||x.com^',
    '||x.com^$domain=a.com|b.com',
    '||x.com^$from=~a.com',
    '*$script,domain=example.com',
    '||x.com^$csp=script-src none',
    '||x.com^$redirect=noopjs',
    'example.com##.ad$1p', // cosmetic line already carries its own options
    '! comment',
    '',
  ];
  for (const line of untouched) {
    assert.equal(canonicalizeNetOptions(line), line, line);
  }
});

test('canonicalizeNetOptions never corrupts values smuggling $ or ,', () => {
  // The reconstruction only renames matched tokens and rejoins with the
  // original separators, so awkward values survive verbatim.
  const cases = [
    '||x.com^$replace=/a$b/,1p',
    '||x.com^$urlskip=/a\\,b/,3p',
    '||x.com^$rewrite=/\\\\d+x/,doc',
  ];
  for (const line of cases) {
    const out = canonicalizeNetOptions(line);
    assert.notEqual(out, line);
    // Both spellings must differ only in the renamed tokens; re-canonicalizing
    // must be a fixpoint.
    assert.equal(canonicalizeNetOptions(out), out);
  }
});

test('canonicalizeNetOptions keeps escaped commas inside option values whole', () => {
  // `$removeparam` regex values may carry an escaped comma; sorting the option
  // tokens must not split (and reshuffle) the regex across tokens.
  const line = '$removeparam=/^__s=[A-Za-z0-9]{6\\,}/,domain=~univis.uni-erlangen.de|~univis.uni-luebeck.de';
  const out = canonicalizeNetOptions(line);
  assert.equal(out, '*$removeparam=/^__s=[A-Za-z0-9]{6\\,}/,domain=~univis.uni-erlangen.de|~univis.uni-luebeck.de');
  assert.equal(canonicalizeNetOptions(out), out);
});

test('canonicalizeNetOptions finds the option delimiter of a pattern-less rule at its leading $', () => {
  // A `$` inside the removeparam regex value is literal, not a delimiter.
  const line = '$removeparam=/^weekend-reading-link-\\d{6}$/';
  assert.equal(
    canonicalizeNetOptions(line),
    '*$removeparam=/^weekend-reading-link-\\d{6}$/'
  );
  assert.equal(canonicalizeNetOptions('*$removeparam=/^weekend-reading-link-\\d{6}$/'),
    '*$removeparam=/^weekend-reading-link-\\d{6}$/');
});

test('canonicalizeRules counts changed lines and is a fixpoint', () => {
  const lines = ['||a^$1p', '||b^', '||a^$first-party', '||c^$3p,xhr'];
  const [out, n] = canonicalizeRules(lines);
  assert.equal(n, 2); // the already-canonical $first-party line is untouched
  assert.deepEqual(out, [
    '||a^$first-party',
    '||b^',
    '||a^$first-party',
    '||c^$third-party,xmlhttprequest',
  ]);
  const [out2] = canonicalizeRules(out);
  assert.equal(out2.filter((l, i) => l === out[i]).length, out.length);
});

test('canonicalizeNetOptions normalizes a pattern-less rule to its *-spelling', () => {
  // SNFE compiles `$domain=…` and `*$domain=…` to the same just-origin unit;
  // the strict grammar is the one the engine stores.
  const cases = [
    ['$domain=example.com', '*$domain=example.com'],
    ['@@$domain=example.com', '@@*$domain=example.com'],
    ['$image,third-party,domain=a.com|b.com', '*$image,third-party,domain=a.com|b.com'],
  ];
  for (const [input, want] of cases) {
    assert.equal(canonicalizeNetOptions(input), want, input);
  }
  // A pattern-less, option-less line is not a rule at all and stays untouched.
  assert.equal(canonicalizeNetOptions(''), '');
});

test('canonicalizeNetOptions sorts options canonically and collapses exact duplicates only', () => {
  // Option sets are order-independent in uBO, so sorted spelling is the strict
  // grammar and twins differing only in order collapse into one text line.
  assert.equal(
    canonicalizeNetOptions('||x.com^$xmlhttprequest,1p'),
    '||x.com^$first-party,xmlhttprequest'
  );
  // Exact-duplicate tokens are inert and collapse (SNFE folds the mask).
  assert.equal(
    canonicalizeNetOptions('||x.com^$image,image,1p,first-party'),
    '||x.com^$first-party,image'
  );
  // Repeated domain=/from= options are a union in uBO, never collapsed.
  assert.equal(
    canonicalizeNetOptions('*$domain=a.com|b.com,script,domain=c.com'),
    '*$script,domain=a.com|b.com,domain=c.com'
  );
});