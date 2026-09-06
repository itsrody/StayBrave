import test from 'node:test';
import assert from 'node:assert/strict';
import { subtractProvided } from '../src/provided.js';

const ours = [
  // exact-text duplicate
  '||ads.example.com^',
  // network subsumed by provided parent host
  '||sub.ads.network^',
  '||other.net/x/y^',
  // cosmetic covered by provided broader host scope
  'www.promo.com##.sponsor-block',
  'deep.site.net##.banner-slot',
  // procedural covered by provided plain hide on same base
  'tracker.io#?#.ad-box:has-text(sponsored)',
  // must be kept
  '||unique-ad.com^',
  '||kept.com/path^$script',
  'example.org##.kept-rule',
  '@@||ads.example.com^',
  'exclude.org##.sponsor-block',
];

const provided = [
  '||ads.example.com^',
  '||ads.network^',
  '||other.net^',
  'promo.com##.sponsor-block',
  'site.net##.banner-slot',
  '##.ad-box',
];

test('drops exact-text duplicates', () => {
  const r = subtractProvided(['||ads.example.com^'], ['||ads.example.com^']);
  assert.deepEqual(r.rules, []);
  assert.equal(r.exactRemoved.length, 1);
});

test('drops network rules subsumed by provided parent host', () => {
  const r = subtractProvided(ours, provided);
  assert.ok(!r.rules.includes('||ads.example.com^'));
  assert.ok(!r.rules.includes('||sub.ads.network^'));
  assert.ok(!r.rules.includes('||other.net/x/y^'));
});

test('drops cosmetic rules covered by provided broader scope', () => {
  const r = subtractProvided(ours, provided);
  assert.ok(!r.rules.includes('www.promo.com##.sponsor-block'));
  assert.ok(!r.rules.includes('deep.site.net##.banner-slot'));
});

test('drops procedural rule covered by provided plain hide on same base', () => {
  const r = subtractProvided(ours, provided);
  assert.ok(!r.rules.includes('tracker.io#?#.ad-box:has-text(sponsored)'));
});

test('never tail-covers into larger effective rules', () => {
  const r = subtractProvided(['||example.com^'], ['||sub.example.com^']);
  assert.deepEqual(r.rules, ['||example.com^']);
});

test('keeps non-covered and exceptions', () => {
  const r = subtractProvided(ours, provided);
  assert.ok(r.rules.includes('||unique-ad.com^'));
  assert.ok(r.rules.includes('||kept.com/path^$script'));
  assert.ok(r.rules.includes('example.org##.kept-rule'));
  assert.ok(r.rules.includes('@@||ads.example.com^'));
  assert.ok(r.rules.includes('exclude.org##.sponsor-block'));
});

test('entity wildcard scope covers concrete hosts', () => {
  const r = subtractProvided(
    ['example.com##.banner', 'foo.example.com##.banner'],
    ['example.*##.banner']
  );
  assert.deepEqual(r.rules, []);
});

test('cosmetic never covered by unrelated selector', () => {
  const r = subtractProvided(
    ['example.com##.banner'],
    ['example.com##.ad']
  );
  assert.deepEqual(r.rules, ['example.com##.banner']);
});