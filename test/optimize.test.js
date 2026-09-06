import test from 'node:test';
import assert from 'node:assert/strict';
import { countFirefoxExclusives } from '../src/optimize.js';

test('countFirefoxExclusives tallies Firefox-only rule families', () => {
  const lines = [
    'example.com##^script:has-text(fake)',
    'example.com#@#^div:has-text(native)',
    'other.com##^responseheader(csp-report-uri:)',
    'site.org##+js(nacl.js)',
    'site.org#@#+js(trusted-set-constant, foo)',
    '@@*$cname',
    '*$script,ipaddress=192.168.*',
    '||x.com^$ipaddress=lan',
    "||x.com^$csp=script-src none",
    '||y.com^$replace=/foo/bar/',
    '||y.com^$uritransform=/foo/bar/',
    '*$urlskip=/^https:\\/\\/x\\.com/',
    '||plain.example^',
    'plain.example##.ad',
  ];
  const c = countFirefoxExclusives(lines);
  assert.equal(c.html_filters, 2); // ##^ + #@#^
  assert.equal(c.responseheaders, 1);
  assert.equal(c.scriptlets, 2); // ##+js + #@#+js
  assert.equal(c.cname, 1);
  assert.equal(c.ipaddress, 2);
  assert.equal(c.csp, 1);
  assert.equal(c.replace, 1);
  assert.equal(c.uritransform, 1);
  assert.equal(c.urlskip, 1);
});

test('countFirefoxExclusives ignores non-matching rules', () => {
  const lines = ['||example.com^', 'example.com##.ad', '! comment'];
  const c = countFirefoxExclusives(lines);
  assert.deepEqual(c, {
    html_filters: 0,
    responseheaders: 0,
    scriptlets: 0,
    cname: 0,
    ipaddress: 0,
    csp: 0,
    replace: 0,
    uritransform: 0,
    urlskip: 0,
  });
});