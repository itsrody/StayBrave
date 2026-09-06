import test from 'node:test';
import assert from 'node:assert/strict';
import { makeParser, parseLine, AST_ERROR, AST_FLAG } from '../src/ubo.js';
import { analyzeText } from '../src/analyze.js';

test('parseLine classifies representative lines', () => {
  const parser = makeParser();
  const cases = [
    ['||example.com^', 'network', true],
    ['@@||example.com^', 'network', true],
    ['||example.com^$script,third-party', 'network', true],
    ['example.com##.ad-banner', 'cosmetic', true],
    ['example.com#?#.ad:has-text(sponsored)', 'cosmetic', true],
    ['example.com##+js(nacl.js)', 'scriptlet', true],
    ['example.com##^div', 'html', true],
    // `$responseheader=` is not a network option in this ubo-core build; uBO
    // only accepts the extended `##^responseheader(...)` form, so the rule is
    // dropped (OPTION_UNKNOWN) rather than shipped.
    ['||example.com^$responseheader=location', 'network', false],
    ['! a comment', 'comment-or-unknown', true],
    ['||example.org^$unknown-option', 'network', false],
  ];
  for (const [raw, kind, ok] of cases) {
    const p = parseLine(parser, raw);
    assert.equal(p.kind, kind, raw);
    assert.equal(p.ok, ok, raw);
  }
});

test('parseLine flags exceptions and strong cosmetic', () => {
  const parser = makeParser();
  const exp = parseLine(parser, '@@||example.com^');
  assert.equal(exp.exception, true);
  const strong = parseLine(parser, 'example.com#?#.ad:has-text(sponsored)');
  assert.equal(strong.strong, true);
});

test('trusted scriptlet is untrusted-source unless keep_trusted_only', () => {
  const untrusted = makeParser({ keep_trusted_only: false });
  const p = parseLine(untrusted, 'example.com##+js(trusted-click-element, .x)');
  assert.equal(p.ok, false);
  assert.notEqual(p.error & AST_ERROR.UNTRUSTED_SOURCE, 0);
  assert.equal(p.kind, 'scriptlet');

  const trusted = makeParser({ keep_trusted_only: true });
  const q = parseLine(trusted, 'example.com##+js(trusted-click-element, .x)');
  assert.equal(q.ok, true);
  assert.equal(q.error & AST_ERROR.UNTRUSTED_SOURCE, 0);
});

test('analyzeText drops trusted scriptlets from untrusted sources', () => {
  const filter = { keep_trusted_only: false, scriptlets: true, cosmetic_cost: {} };
  const { lines } = analyzeText(
    'example.com##+js(trusted-click-element, .x)\nexample.org##+js(nacl.js)\n',
    filter,
    false
  );
  assert.deepEqual(lines, ['example.org##+js(nacl.js)']);
});

test('analyzeText keeps trusted scriptlets under keep_trusted_only', () => {
  const filter = { keep_trusted_only: true, scriptlets: true, cosmetic_cost: {} };
  const { lines } = analyzeText(
    'example.com##+js(trusted-click-element, .x)\n',
    filter,
    false
  );
  assert.deepEqual(lines, ['example.com##+js(trusted-click-element, .x)']);
});

test('shared parser across sources yields the same result as per-source parsers', () => {
  const a = '||one.example^\n||two.example^$script\nexample.com##.ad\n';
  const b = '||three.example^^\n';
  const filter = { keep_trusted_only: false, scriptlets: true, cosmetic_cost: {} };

  const shared = makeParser({ keep_trusted_only: false });
  const rShared = [
    ...analyzeText(a, filter, false, shared).lines,
    ...analyzeText(b, filter, false, shared).lines,
  ];
  const rPerSource = [
    ...analyzeText(a, filter, false).lines,
    ...analyzeText(b, filter, false).lines,
  ];
  assert.deepEqual(rShared, rPerSource);
});

test('parser instance is stateless between parse() calls', () => {
  const parser = makeParser();
  const first = parseLine(parser, '||one.example^');
  const second = parseLine(parser, '||two.example^$script');
  assert.equal(first.kind, 'network');
  assert.equal(second.kind, 'network');
  assert.equal(second.options, true);
  assert.equal((second.error & AST_ERROR.NONE) === 0, true);
});