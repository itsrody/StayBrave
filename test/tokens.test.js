import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BAD_TOKENS, MAX_TOKEN_LENGTH, mirrorTokenFromPattern, mirrorTokenFromQuerypruneValue, mirrorTokenFromRegex } from '../src/tokens.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('BAD_TOKENS is byte-parity with the pinned engine source', () => {
  const src = readFileSync(
    join(root, 'node_modules/@gorhill/ubo-core/js/static-net-filtering.js'),
    'utf8'
  );
  const start = src.indexOf("this.badTokens = new Map([");
  assert.ok(start !== -1, 'badTokens map not found in pinned source');
  const end = src.indexOf(']);', start);
  const entries = [];
  const re = /^\s*\[\s*['"]([^'"]+)['"]\s*,\s*(\d+)\s*\]\s*,?\s*$/m;
  for (const line of src.slice(start, end).split('\n')) {
    const m = re.exec(line);
    if (m !== null) entries.push([m[1], Number(m[2])]);
  }
  assert.equal(entries.length, BAD_TOKENS.size, 'token-count drift from engine');
  const theirs = new Map(entries);
  assert.deepEqual(BAD_TOKENS, theirs);
});

test('mirror picks a distinctive token over adjacent generic ones', () => {
  assert.deepEqual(mirrorTokenFromPattern('cdn.example.net/js/main.js'), {
    token: 'example',
    badness: 0,
  });
});

test('token runs already normalized by the parser feed the mirror', () => {
  // parser.getNetPattern() strips `||`/`^`; makeToken runs on the same text.
  assert.deepEqual(mirrorTokenFromPattern('example.com/path^'), {
    token: 'example',
    badness: 0,
  });
});

test('wildcard-adjacent runs are skipped, leaving no token', () => {
  // `*/ads/*` keeps the `ads` run (separated from the wildcards by `/`), but a
  // run literally abutted by `*` on both sides can not be a token.
  assert.equal(mirrorTokenFromPattern('*ads*'), null);
  assert.equal(mirrorTokenFromPattern('*'), null);
  assert.deepEqual(mirrorTokenFromPattern('*/ads/*'), {
    token: 'ads',
    badness: 0,
  });
});

test('a generics-only pattern resolves to the least-bad token', () => {
  assert.deepEqual(mirrorTokenFromPattern('https.com/image'), {
    token: 'image',
    badness: 5028,
  });
});

test('a 1-char winner is flagged as short', () => {
  const t = mirrorTokenFromPattern('/x/y/z/');
  assert.equal(t.token.length, 1);
  assert.equal(t.badness, 1);
});

test('MAX_TOKEN_LENGTH mirrors the engine cap', () => {
  assert.equal(MAX_TOKEN_LENGTH, 7);
});

test('queryprune value derives a token, matching extractTokenFromQuerypruneValue', () => {
  assert.deepEqual(mirrorTokenFromQuerypruneValue('gclid'), {
    token: 'gclid',
    badness: 0,
  });
  // `*` and `~` values never yield a token.
  assert.equal(mirrorTokenFromQuerypruneValue('*'), null);
  assert.equal(mirrorTokenFromQuerypruneValue('~utm_*'), null);
});

test('queryprune regex value routes through the regex mirror', () => {
  const t = mirrorTokenFromQuerypruneValue('/ad\\d+/');
  assert.notEqual(t, null);
  assert.equal(t.token, 'ad');
});

test('regex mirror recovers a literal token when one exists', () => {
  // Zero-badness run (example) beats the later banner run, engine order.
  assert.deepEqual(mirrorTokenFromRegex('/.example/banner/[0-9]+.js$/'), {
    token: 'example',
    badness: 0,
  });
});

test('regex mirror returns null when no tokenizable literal remains', () => {
  assert.equal(mirrorTokenFromRegex('[A-z0-9]+[-_]?[0-9]+'), null);
});