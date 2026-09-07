import test from 'node:test';
import assert from 'node:assert/strict';
import { removedProbe, verifyRemovedCoverage, certifySupersetRemovals, certifyDeadExceptionRemovals } from '../src/engine.js';
import { certifyCosmeticDeadHides, certifyDeadCosmeticExceptions } from '../src/cosmetic-engine.js';

test('removedProbe derives a request for a plain host rule', () => {
  const p = removedProbe('||ads.example.com^');
  assert.notEqual(p, null);
  assert.match(p.url, /^http:\/\/ads\.example\.com\/probe-[0-9a-z]+\.js$/);
  assert.equal(p.type, 'script');
  assert.equal(p.originURL.startsWith('http://origin-'), true);
});

test('removedProbe honors type, scheme, party and path options', () => {
  const image = removedProbe('||img.example.com^$image');
  assert.equal(image.type, 'image');
  const https = removedProbe('||s.example.com^$https');
  assert.match(https.url, /^https:\/\//);
  const firstParty = removedProbe('||f.example.com^$first-party');
  assert.equal(firstParty.originURL, 'http://f.example.com/');
  const path = removedProbe('||x.example.com/pix^');
  assert.match(path.url, /^http:\/\/x\.example\.com\/pix\/probe-/);
});

test('removedProbe returns null for non-probeable shapes', () => {
  assert.equal(removedProbe('/ads/foo.*'), null);
  assert.equal(removedProbe('example.com/frame'), null);
  assert.equal(removedProbe('||*.example.com^'), null);
});

test('verifyRemovedCoverage: a covered removal is certified', async () => {
  // `||ads.example.com^` is dominated by `||example.com^`; removing it keeps
  // coverage, so the recheck must find zero holes.
  const survivors = ['||example.com^', 'example.com##.ad'];
  const preOpt = ['||example.com^', '||ads.example.com^', 'example.com##.ad'];
  const result = await verifyRemovedCoverage(preOpt, survivors, ['||ads.example.com^']);
  assert.equal(result.holes.length, 0);
  assert.equal(result.verified, 1);
  assert.equal(result.unblocked_safe, 0);
});

test('verifyRemovedCoverage: an uncovered removal is flagged as a hole', async () => {
  // `||isolated.example.net^` has no survivor covering it; a buggy optimizer
  // that removes it must be caught.
  const survivors = ['||example.com^'];
  const preOpt = ['||example.com^', '||isolated.example.net^'];
  const result = await verifyRemovedCoverage(preOpt, survivors, ['||isolated.example.net^']);
  assert.deepEqual(result.holes, ['||isolated.example.net^']);
  assert.equal(result.verified, 0);
});

test('verifyRemovedCoverage: exception-cancelled removal is safe, not a hole', async () => {
  // `||ads.example.com^` removed, but the exception `@@||ads.example.com^`
  // unbinds it in both the pre-opt and survivor sets — no coverage is lost.
  const survivors = ['||example.com^', '@@||ads.example.com^'];
  const preOpt = [
    '||example.com^',
    '||ads.example.com^',
    '@@||ads.example.com^',
  ];
  const result = await verifyRemovedCoverage(
    preOpt,
    survivors,
    ['||ads.example.com^']
  );
  assert.equal(result.holes.length, 0);
  assert.equal(result.unblocked_safe, 1);
  assert.equal(result.verified, 0);
});

test('verifyRemovedCoverage: subsumable-option removal still covered', async () => {
  const survivors = ['||local.com^'];
  const preOpt = ['||local.com^', '||ad.local.com^$image,third-party'];
  const result = await verifyRemovedCoverage(
    preOpt,
    survivors,
    ['||ad.local.com^$image,third-party']
  );
  assert.equal(result.holes.length, 0);
  assert.equal(result.verified, 1);
});

test('certifySupersetRemovals: covered child is certified for removal', async () => {
  const survivors = ['||example.com^', '||sub.example.com^'];
  const { certified, candidates } = await certifySupersetRemovals(
    ['||sub.example.com^'],
    survivors
  );
  assert.deepEqual(certified, ['||sub.example.com^']);
  assert.deepEqual(candidates, ['||sub.example.com^']);
});

test('certifySupersetRemovals: uncovered candidate is rejected', async () => {
  const survivors = ['||example.com^', '||isolated.net^'];
  const { certified } = await certifySupersetRemovals(
    ['||isolated.net^'],
    survivors
  );
  assert.deepEqual(certified, []);
});

test('certifySupersetRemovals: dead-by-exception candidate certifies as unblocked', async () => {
  const survivors = ['||example.com^', '||ads.example.com^', '@@||ads.example.com^'];
  const { certified } = await certifySupersetRemovals(
    ['||ads.example.com^'],
    survivors,
    ['||ads.example.com^']
  );
  assert.deepEqual(certified, ['||ads.example.com^']);
});

test('certifySupersetRemovals: scoped victim probed at its own domain', async () => {
  const survivors = [
    '||news.com^$domain=news.com',
    '||ads.news.com^$domain=news.com',
  ];
  const { certified } = await certifySupersetRemovals(
    ['||ads.news.com^$domain=news.com'],
    survivors
  );
  assert.deepEqual(certified, ['||ads.news.com^$domain=news.com']);
});

test('certifyCosmeticDeadHides: equal-scope exception certificates the hide', async () => {
  const all = ['example.com##.ad', 'example.com#@#.ad'];
  const certified = await certifyCosmeticDeadHides(['example.com##.ad'], all);
  assert.deepEqual(certified, ['example.com##.ad']);
});

test('certifyCosmeticDeadHides: generic exception certificates host hide', async () => {
  const all = ['example.com##.ad', '#@#.ad'];
  const certified = await certifyCosmeticDeadHides(['example.com##.ad'], all);
  assert.deepEqual(certified, ['example.com##.ad']);
});

test('certifyCosmeticDeadHides: hide still delivered is rejected', async () => {
  const all = ['example.com##.ad'];
  const certified = await certifyCosmeticDeadHides(['example.com##.ad'], all);
  assert.deepEqual(certified, []);
});
test('certifyDeadExceptionRemovals: exception with no surviving block is certified', async () => {
  const survivors = ['||example.com^', '||isolated.net^'];
  const { certified } = await certifyDeadExceptionRemovals(
    ['@@||ghost-host.net^'],
    survivors
  );
  assert.deepEqual(certified, ['@@||ghost-host.net^']);
});

test('certifyDeadExceptionRemovals: exception that unbinds a surviving block is rejected', async () => {
  const survivors = ['||example.com^', '@@||example.com^'];
  const { certified } = await certifyDeadExceptionRemovals(
    ['@@||example.com^'],
    survivors
  );
  assert.deepEqual(certified, []);
});

test('certifyDeadExceptionRemovals: scoped dead exception probes its own document', async () => {
  // The exception only applies on news.com documents; no block binds it there,
  // so removal changes nothing.
  const survivors = ['||ads.example.com^', '@@||ads.news.com^$domain=news.com'];
  const { certified } = await certifyDeadExceptionRemovals(
    ['@@||ads.news.com^$domain=news.com'],
    survivors
  );
  assert.deepEqual(certified, ['@@||ads.news.com^$domain=news.com']);
});

test('certifyDeadExceptionRemovals: a candidate must not certify itself', async () => {
  // Without the other block, the only thing `@@||x.com^` could whitelist is
  // itself; with candidates excluded from the probe set it must be rejected.
  const survivors = ['||x.com^', '@@||sub.x.com^'];
  const { certified } = await certifyDeadExceptionRemovals(
    ['@@||sub.x.com^'],
    survivors
  );
  assert.deepEqual(certified, []);
});

test('certifyDeadCosmeticExceptions: selector-less exception is certified', async () => {
  const all = ['example.com##.ad', 'example.com#@#.ghost'];
  const certified = await certifyDeadCosmeticExceptions(
    ['example.com#@#.ghost'],
    all
  );
  assert.deepEqual(certified, ['example.com#@#.ghost']);
});

test('certifyDeadCosmeticExceptions: exception with a live hide is rejected', async () => {
  const all = ['example.com##.ad', 'example.com#@#.ad'];
  const certified = await certifyDeadCosmeticExceptions(
    ['example.com#@#.ad'],
    all
  );
  assert.deepEqual(certified, []);
});

test('certifyDeadCosmeticExceptions: weak exception is inert against a strong hide and is certified', async () => {
  // Engine-verified: `#?#` strong hides are not withdrawn by a weak `#@#`
  // exception, so the exception can never affect delivery.
  const all = ['example.com#?#.ad'];
  const certified = await certifyDeadCosmeticExceptions(
    ['example.com#@#.ad'],
    all
  );
  assert.deepEqual(certified, ['example.com#@#.ad']);
});
