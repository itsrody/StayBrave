import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCosmetic,
  transformCosmetic,
  isProcedural,
  subsumeSelectors,
  subsumeProcedural,
  plainBase,
  classifyChannel,
  Channel,
  firstClassIdToken,
  deadHidesByException,
} from '../src/cosmetic.js';

test('splitCosmetic handles hide/unhide/html/strong', () => {
  assert.deepEqual(splitCosmetic('example.com##.ad'), { host: 'example.com', sep: '##', selector: '.ad' });
  assert.deepEqual(splitCosmetic('example.com#@#.ad'), { host: 'example.com', sep: '#@#', selector: '.ad' });
  assert.equal(splitCosmetic('example.com##^script:has-text(ads)'), null);
  assert.equal(splitCosmetic('example.com#?#.ad'), null);
  assert.equal(splitCosmetic('||example.com^'), null);
});

test('isProcedural detects procedural and action operators', () => {
  for (const sel of [':has-text(foo)', ':upward(1)', ':style(display:none)', ':remove()', ':contains(foo)']) {
    assert.ok(isProcedural(sel), sel);
  }
  for (const sel of ['.ad', 'div.ad', '#ad', 'div']) {
    assert.ok(!isProcedural(sel), sel);
  }
});

test('rewrites uBO dead operators to live equivalents', () => {
  const { lines } = transformCosmetic('example.com##.a:contains(foo)');
  assert.deepEqual(lines, ['example.com##.a:has-text(foo)']);
  const r2 = transformCosmetic('example.com##.a:nth-ancestor(1)');
  assert.deepEqual(r2.lines, ['example.com##.a:upward(1)']);
});

test('drops dead operators in uBO', () => {
  assert.equal(transformCosmetic('example.com##.a:others(.b)').lines.length, 0);
  assert.equal(transformCosmetic('example.com##.a:-abp-properties(target)').lines.length, 0);
});

test('strips inert actions', () => {
  assert.deepEqual(transformCosmetic('example.com##.a:min-text-length(0)').lines, ['example.com##.a']);
  assert.deepEqual(transformCosmetic('example.com##.a:style(display: none)').lines, ['example.com##.a']);
  // Non-display styles survive.
  assert.deepEqual(
    transformCosmetic('example.com##.a:style(background: none)').lines,
    ['example.com##.a:style(background: none)']
  );
});

test('wraps bare selector list split', () => {
  assert.deepEqual(
    transformCosmetic('example.com##.b, .a', { splitCommaLists: false }).lines,
    ['example.com##.a,.b']
  );
});

test('splits procedural comma lists', () => {
  const { lines } = transformCosmetic('example.com##.a, .b:has-text(foo)');
  assert.deepEqual(lines, ['example.com##.a', 'example.com##.b:has-text(foo)']);
});

test('passes non-cosmetic and opaque lines through untouched', () => {
  for (const line of [
    '||example.com^$script',
    'example.com##^script:has-text(ads)',
    'example.com#?#.x',
    'example.com##^responseheader(location)',
  ]) {
    const { lines } = transformCosmetic(line);
    assert.deepEqual(lines, [line]);
  }
});

test('classifyChannel taxonomy', () => {
  assert.equal(classifyChannel('##.a'), Channel.SimpleClassId);
  assert.equal(classifyChannel('##.a.b'), Channel.ComplexTokenLed);
  assert.equal(classifyChannel('##div'), Channel.GenericMisc);
  assert.equal(classifyChannel('example.com##.x'), Channel.HostnameHide);
  assert.equal(classifyChannel('example.com#@#.y'), Channel.HostnameUnhide);
  assert.equal(classifyChannel('example.com##.z:has-text(w)'), Channel.Procedural);
});

test('generic never covers host-scoped', () => {
  const [kept, removed] = subsumeSelectors(['##.ad', 'example.com##.ad']);
  assert.equal(removed, 0);
  assert.deepEqual(kept, ['##.ad', 'example.com##.ad']);
});

test('identical selector broader scope covers narrower', () => {
  const [kept, removed] = subsumeSelectors([
    'example.com##.ad',
    '*.example.com##.ad',
    'www.example.com##.ad',
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['example.com##.ad', '*.example.com##.ad']);
});

test('parent host covers subdomain (registrable-domain safe)', () => {
  const [kept, removed] = subsumeSelectors([
    'example.com##.ad',
    'www.example.com##.ad',
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['example.com##.ad']);
});

test('generic never covers host-scoped even for bare tokens', () => {
  // uBO can switch off generic cosmetic filtering per-site ($generichide), so
  // a generic `##.ad` must not erase the domain-scoped `example.com##div.ad`.
  const [kept, removed] = subsumeSelectors(['##.ad', 'example.com##div.ad']);
  assert.equal(removed, 0);
  assert.deepEqual(kept, ['##.ad', 'example.com##div.ad']);
});

test('unrelated hosts not covered', () => {
  const [kept, removed] = subsumeSelectors([
    'a.com##.ad',
    'b.com##.ad',
  ]);
  assert.equal(removed, 0);
  assert.deepEqual(kept, ['a.com##.ad', 'b.com##.ad']);
});

test('plainBase strips constraints', () => {
  assert.equal(plainBase('.a:has-text(foo):style(display:none)'), '.a');
  assert.equal(plainBase('.a:upward(1)'), undefined);
});

test('plain hide subsumes procedural variant on same scope', () => {
  const [kept, removed] = subsumeProcedural([
    'example.com##.a',
    'example.com##.a:has-text(foo)',
    'not-example.com##.a:has-text(foo)',
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['example.com##.a', 'not-example.com##.a:has-text(foo)']);
});

test('identical procedural selector broader scope covers', () => {
  const [kept, removed] = subsumeProcedural([
    'example.com##.a:has-text(foo)',
    'www.example.com##.a:has-text(foo)',
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['example.com##.a:has-text(foo)']);
});

test('constraint-count subsumption', () => {
  // A constraint-richer variant (`:has-text(foo):matches-css(...)`) is
  // strictly covered by the constraint-poorer `:has-text(foo)` on the same
  // scope, so uBO-safe removal collapses it.
  const [kept, removed] = subsumeProcedural([
    'example.com##.a:has-text(foo)',
    'example.com##.a:has-text(foo):matches-css(max-height: 30px)',
  ]);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['example.com##.a:has-text(foo)']);
});

test('generic never covers host-scoped procedural', () => {
  const [kept, removed] = subsumeProcedural([
    '##.a:has-text(foo)',
    'example.com##.a:has-text(foo)',
  ]);
  assert.equal(removed, 0);
});

test('firstClassIdToken', () => {
  assert.equal(firstClassIdToken('.ad'), '.ad');
  assert.equal(firstClassIdToken('.ad-x div'), '.ad-x');
  assert.equal(firstClassIdToken('#ad'), '#ad');
  assert.equal(firstClassIdToken('div.ad'), undefined);
});

test('A: equal-scope exception kills the same-selector hide (candidate)', () => {
  const { removed_lines } = deadHidesByException([
    'example.com##.ad',
    'example.com#@#.ad',
  ]);
  assert.deepEqual(removed_lines, ['example.com##.ad']);
});

test('A: broader host exception kills subdomain hide (candidate)', () => {
  const { removed_lines } = deadHidesByException([
    'sub.example.com##.ad',
    'example.com#@#.ad',
  ]);
  assert.deepEqual(removed_lines, ['sub.example.com##.ad']);
});

test('C: generic exception kills host-scoped hide (candidate)', () => {
  const { removed_lines } = deadHidesByException(['example.com##.ad', '#@#.ad']);
  assert.deepEqual(removed_lines, ['example.com##.ad']);
});

test('narrower exception never kills a broader hide (no candidate)', () => {
  const { removed_lines } = deadHidesByException([
    'example.com##.ad',
    'sub.example.com#@#.ad',
  ]);
  assert.deepEqual(removed_lines, []);
});

test('host exception never kills a generic hide (no candidate)', () => {
  const { removed_lines } = deadHidesByException(['##.ad', 'example.com#@#.ad']);
  assert.deepEqual(removed_lines, []);
});

test('generic exceptions cancel each other out of the candidate set', () => {
  const { removed_lines } = deadHidesByException(['##.ad', '#@#.ad', '##.banner']);
  assert.deepEqual(removed_lines, ['##.ad']);
});

test('procedural hides are not candidates', () => {
  const { removed_lines } = deadHidesByException([
    'example.com##.ad:has-text(x)',
    'example.com#@#.ad:has-text(x)',
  ]);
  assert.deepEqual(removed_lines, []);
});

test('unrelated selectors stay untouched', () => {
  const { removed_lines } = deadHidesByException([
    'example.com##.ad',
    'example.com#@#.banner',
  ]);
  assert.deepEqual(removed_lines, []);
});