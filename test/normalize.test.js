import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLine,
  normalizeHostsLine,
} from '../src/normalize.js';

test('expands hosts lines', () => {
  const n = normalizeLine('0.0.0.0 example.com evil.com');
  assert.ok(n.hostsConverted);
  assert.deepEqual(n.lines, ['||example.com^', '||evil.com^']);
});

test('handles ipv6 hosts entries', () => {
  const n = normalizeLine('::1 tracking.example.com');
  assert.ok(n.hostsConverted);
  assert.deepEqual(n.lines, ['||tracking.example.com^']);
});

test('strips comments and localhost aliases', () => {
  const n = normalizeLine('0.0.0.0 localhost ip6-loopback ads.example.com # comment');
  assert.deepEqual(n.lines, ['||ads.example.com^']);
});

test('all-localhost hosts lines dropped', () => {
  for (const line of [
    '0.0.0.0 localhost ip6-allhosts broadcasthost',
    'ff00::0 ip6-localnet',
    '255.255.255.255 broadcasthost',
  ]) {
    const n = normalizeLine(line);
    assert.equal(n.lines.length, 0, line);
  }
});

test('non-hosts lines not converted', () => {
  const n = normalizeLine('||example.com^');
  assert.ok(!n.hostsConverted);
  assert.deepEqual(n.lines, ['||example.com^']);
  const c = normalizeLine('# comment');
  assert.ok(!c.hostsConverted);
  assert.deepEqual(c.lines, ['# comment']);
});

test('uBO shorthand options left untouched (native)', () => {
  // uBO parses $empty / $mp4 natively; rewriting would be pointless.
  assert.deepEqual(normalizeLine('||example.com^$empty').lines, ['||example.com^$empty']);
  assert.deepEqual(normalizeLine('||example.com^$mp4').lines, ['||example.com^$mp4']);
});

test('canonicalizes redirect values', () => {
  assert.deepEqual(normalizeLine('||example.com^$redirect=noopjs').lines, ['||example.com^$redirect=noop.js']);
  assert.deepEqual(normalizeLine('||example.com^$redirect-rule=noopmp4-1s').lines, ['||example.com^$redirect-rule=noop-1s.mp4']);
  assert.deepEqual(normalizeLine('||example.com^$rewrite=abp-resource:blank-mp4').lines, ['||example.com^$rewrite=noop-1s.mp4']);
  assert.deepEqual(normalizeLine('||example.com^$rewrite=abp-resource:blank-js').lines, ['||example.com^$rewrite=noop.js']);
});

test('leaves known syntax untouched', () => {
  for (const line of [
    '||example.com^$redirect=noop-1s.mp4',
    '||example.com^$redirect=empty',
    '||example.com^$3p',
    '||example.com^$from=example.com',
    '||example.com^$xhr',
    '||example.com^$removeparam=x',
    '||example.com^$csp=script-src \'none\'',
  ]) {
    assert.deepEqual(normalizeLine(line).lines, [line]);
  }
});

test('hosts format drops comments', () => {
  for (const line of [
    '# Title: StevenBlack/hosts',
    '#0.0.0.0 aax-eu.amazon-adsystem.com',
    '### Version: V1.2021.05.8588',
  ]) {
    const n = normalizeHostsLine(line);
    assert.equal(n.lines.length, 0, `should drop ${line}`);
    assert.ok(!n.hostsConverted);
  }
});

test('hosts format converts ip and bare domains', () => {
  let n = normalizeHostsLine('0.0.0.0 example.com evil.com');
  assert.ok(n.hostsConverted);
  assert.deepEqual(n.lines, ['||example.com^', '||evil.com^']);
  n = normalizeHostsLine('ads.example.net');
  assert.ok(n.hostsConverted);
  assert.deepEqual(n.lines, ['||ads.example.net^']);
});

test('hosts format passes hybrid lines through', () => {
  const n = normalizeHostsLine('||example.com^$script');
  assert.ok(!n.hostsConverted);
  assert.deepEqual(n.lines, ['||example.com^$script']);
});