import test from 'node:test';
import assert from 'node:assert/strict';
import { stripLite, hasEntityDomain, isRegexRule, liteEmptyStats } from '../src/lite.js';

test('keeps plain network and CSS-only cosmetic rules', () => {
  const lines = [
    '||ads.example.com^',
    '||ads.example.com/banner.js$script,third-party',
    '@@||ads.example.com^$document',
    'example.com##.ad',
    'example.com,.cn##.banner, .popup',
    'example.com##.ad:has(.x):not(.y)',
    '*$removeparam=utm_source',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, lines);
  assert.deepEqual(stats, { ...liteEmptyStats(), total: lines.length });
});

test('drops scriptlets, html, responseheaders, strong cosmetics', () => {
  const lines = [
    'example.com##+js(set-constant, foo, bar)',
    'example.com#@#+js(aopr, x)',
    'example.com##^script[src]',
    'example.com##^responseheader:content-length',
    'example.com#?#.ad:has-text(click)',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, []);
  assert.equal(stats.scriptlets, 2);
  assert.equal(stats.html_filters, 1);
  assert.equal(stats.responseheaders, 1);
  assert.equal(stats.strong_cosmetic, 1);
});

test('drops procedural cosmetics but keeps CSS-hideable selectors', () => {
  const lines = [
    'example.com##.ad:has-text(click)',
    'example.com##.ad:upward(2)',
    'example.com##.ad:style(display:none)',
    'example.com#@#.x:matches-css(width: 1px)',
    'example.com##.ad:has(.x)',
    'example.com##.ad:not(.promo)',
    'example.com##.plain',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, [
    'example.com##.ad:has(.x)',
    'example.com##.ad:not(.promo)',
    'example.com##.plain',
  ]);
  assert.equal(stats.procedural_cosmetic, 4);
});

test('drops regex network rules', () => {
  const lines = [
    '/ads\/(banner|pop)\/./$script',
    '||simple.com^',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, ['||simple.com^']);
  assert.equal(stats.regex_network, 1);
  assert.equal(isRegexRule('/foo/$script'), true);
  assert.equal(isRegexRule('||foo.com^'), false);
});

test('drops entity-wildcard $domain rules whole', () => {
  const lines = [
    '||example.com^$domain=amazon.*',
    '||example.com^$domain=example.org|gmx.*',
    '@@||example.com^$domain=~google.*|example.org',
    '@@||example.com^$domain=~google.com|example.org',
    '||example.com^$domain=example.com',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, [
    '@@||example.com^$domain=~google.com|example.org',
    '||example.com^$domain=example.com',
  ]);
  assert.equal(stats.entity_domain, 3);
  assert.equal(hasEntityDomain('domain=amazon.*'), true);
  assert.equal(hasEntityDomain('domain=amazon.com'), false);
  assert.equal(hasEntityDomain('from=~gmx.*'), true);
});

test('drops MV3-unsupported modifiers and modifier values', () => {
  const lines = [
    '@@||example.com^$strict3p',
    '||example.com^$strict1p',
    '||tracker.com^$ipaddress=1.2.3.4',
    '||cn.com^$cname',
    '||pop.com^$popup',
    '||ck.com^$replace=/foo/bar/',
    '||r.com^$redirect-rule=noop.js',
    '@@||e.com^$generichide',
    '||c2l.com^$redirect=click2load.html',
    '||qp.com^$removeparam=/^utm/',
    '||ok.com^$redirect=noop.js',
    '||ok2.com^$removeparam=utm_source',
    '||ok3.com^$csp=script-src \'none\'',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, [
    '||ok.com^$redirect=noop.js',
    '||ok2.com^$removeparam=utm_source',
    '||ok3.com^$csp=script-src \'none\'',
  ]);
  assert.equal(stats.unsupported_modifiers, 10);
});

test('escaped commas inside option values are not option delimiters', () => {
  // A `\,` inside a `removeparam=` value must not split the option list: the
  // entity-detection and modifier scans must read the value as one token, so
  // the shard-turned-bare-option and the non-regex removeparam both survive.
  const lines = [
    '||example.com^$domain=one.com,two.com,removeparam=utm\\,tracker',
    '||example.com^$domain=one.*|two.com',
  ];
  const { lines: kept, stats } = stripLite(lines);
  assert.deepEqual(kept, ['||example.com^$domain=one.com,two.com,removeparam=utm\\,tracker']);
  assert.equal(stats.entity_domain, 1);
  assert.equal(stats.unsupported_modifiers, 0);
});