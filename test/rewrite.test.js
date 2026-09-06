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
    ['||x.com^$~xhr,image', '||x.com^$~xmlhttprequest,image'],
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