import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCosmeticEngine, detectDroppedCosmetics } from '../src/cosmetic-engine.js';

test('detectDroppedCosmetics flags generic procedural rules (stock allowGenericProceduralFilters=false)', async () => {
  const dropped = await detectDroppedCosmetics([
    'example.com##.banner',
    '##div:has(.sponsor)',
    'example.org##.sidebar:has-text(adv)',
    '~bad.net,~worse.net##.notice:style(margin-top: 0 !important;)',
  ]);
  assert.deepEqual([...dropped.keys()], [
    '##div:has(.sponsor)',
    '~bad.net,~worse.net##.notice:style(margin-top: 0 !important;)',
  ]);
});

test('host-anchored procedural selectors are kept', async () => {
  const dropped = await detectDroppedCosmetics([
    'example.com##div.foo:has(> div.bar)',
    'example.com##.x:style(display: none !important;)',
  ]);
  assert.equal(dropped.size, 0);
});

test('makeCosmeticEngine registers units and reports accepted/discarded/dropped', async () => {
  const lines = [
    'example.com##.banner',
    'example.com##.banner',
    'example.org##.ads',
    '##generic.thing',
  ];
  const ce = await makeCosmeticEngine(lines, { name: 'test-list' });
  assert.equal(ce.accepted, 4);
  assert.equal(ce.discarded, 1);
  assert.equal(ce.units, 3);
  assert.equal(ce.dropped.length, 0);
});

test('cosmetic engine excludes strong, scriptlet and HTML cosmetics', async () => {
  // `#?#` strong and `##^` HTML rules are routed by uBO to other engines;
  // `##+js(...)` is a scriptlet. None of them may compile as a cosmetic hide.
  const lines = ['example.com#?#.ad:has-text(sponsored)', 'example.com##^div', 'example.com##+js(nacl.js)'];
  const ce = await makeCosmeticEngine(lines, { name: 'test-list' });
  assert.equal(ce.compiled, 0);
  assert.equal(ce.units, 0);
});

test('retrieveSpecificSelectors returns declarative CSS, procedural raw and style CSS', async () => {
  const ce = await makeCosmeticEngine(
    [
      'example.com##.banner',
      'example.com##div.foo:has(> div.bar)',
      'example.com##.modal:style(display: none !important;)',
    ],
    { name: 'test-list' }
  );
  const out = ce.probe('example.com', 'example.com', 'http://example.com/');
  const cssLines = (out.injectedCSS ?? '').split('\n').map((s) => s.trim().replace(/,$/, ''));
  assert.ok(cssLines.includes('.banner'), 'declarative hide retrieved');
  assert.ok(out.proceduralFilters.some((p) => JSON.parse(p).raw === 'div.foo:has(> div.bar)'));
  assert.ok(
    out.convertedProceduralFilters.some(
      (p) => JSON.parse(p).raw === '.modal:style(display: none !important;)'
    )
  );
});

test('cosmetic exceptions cancel their hide at retrieval', async () => {
  const ce = await makeCosmeticEngine(['example.com##.banner', 'example.com#@#.banner'], {
    name: 'test-list',
  });
  const out = ce.probe('example.com', 'example.com', 'http://example.com/');
  const css = out.injectedCSS ?? '';
  assert.ok(!css.includes('.banner'), 'excepted selector must not be injected');
  assert.ok(out.exceptedFilters.includes('.banner'), 'exceptedFilters reports the cancellation');
});

test('entities and sampled domains resolve at retrieval', async () => {
  const ce = await makeCosmeticEngine(['a.*##.entity-ad'], { name: 'test-list' });
  // a.* (entity) is matched when the probed hostname's domain is a.*, i.e.
  // hostname === domain here.
  const out = ce.probe('a.sample', 'a.sample', 'http://a.sample/');
  assert.ok((out.injectedCSS ?? '').includes('.entity-ad'), 'entity rule matches a.sample');
});