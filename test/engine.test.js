import test from 'node:test';
import assert from 'node:assert/strict';
import { removedProbe, verifyRemovedCoverage } from '../src/engine.js';

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