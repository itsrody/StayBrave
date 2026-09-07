import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRule,
  classifyNetwork,
  analyzeEfficiency,
  gradeOf,
  Channel,
} from '../src/efficiency.js';

test('classifyNetwork mirrors uBO token-bucket dispatch', () => {
  const cases = [
    ['||example.com^', Channel.NetworkTokened],
    ['||example.com^$script,first-party', Channel.NetworkTokened],
    ['||x.com^$domain=a.com|b.com', Channel.NetworkTokened],
    ['*$script', Channel.NetworkCatchall],
    ['*$3p', Channel.NetworkCatchall],
    ['*$script,domain=example.com', Channel.NetworkCatchall],
    ['*ad*', Channel.NetworkCatchall],
    ['*$domain=example.com', Channel.NetworkJustOrigin],
    ['*$domain=a.com|b.com', Channel.NetworkJustOrigin],
    ['|http://$domain=x.com', Channel.NetworkJustOrigin],
    ['|https://$domain=x.com', Channel.NetworkJustOrigin],
    ['/ads/', Channel.NetworkTokened],
    ['ads', Channel.NetworkTokened],
    ['1234', Channel.NetworkTokened],
    // Engine-verified: a pattern-less rule compiles to the same just-origin
    // unit as `*$…`, so the strict grammar resolves to just-origin, not
    // catchall.
    ['$domain=example.com', Channel.NetworkJustOrigin],
    ['@@$domain=example.com', Channel.NetworkJustOrigin],
    ['$script,domain=example.com', Channel.NetworkCatchall],
  ];
  for (const [line, want] of cases) {
    assert.equal(classifyNetwork(line), want, line);
  }
});

test('classifyRule splits exclusives and cosmetics into their own classes', () => {
  assert.equal(classifyRule('||example.com^'), Channel.NetworkTokened);
  assert.equal(classifyRule('example.com##.ad'), Channel.CosmeticGreen);
  assert.equal(classifyRule('example.com#@#.ad'), Channel.CosmeticAmber);
  assert.equal(classifyRule('##div:not(.x)'), Channel.CosmeticRed);
  assert.equal(classifyRule('example.com##^script:has-text(x)'), Channel.HtmlFilter);
  assert.equal(classifyRule('example.com##^responseheader(csp-a:)'), Channel.Responseheader);
  assert.equal(classifyRule('example.com##+js(nacl.js)'), Channel.Scriptlet);
  assert.equal(classifyRule('example.com#@#+js(trusted-set-constant, a)'), Channel.Scriptlet);
  assert.equal(classifyRule('! comment'), null);
  assert.equal(classifyRule(''), null);
});

test('analyzeEfficiency aggregates and grades', () => {
  const lines = [
    '||a.com^',
    '||b.com^$script',
    '||c.com^$domain=x.com|y.com',
    '*$script',
    '*$domain=z.com',
    'example.com##.ad',
    'example.com#@#.ad',
    '##div:not(.generic)',
    'example.com##^script:inject(x)',
    'example.com##+js(noop.js)',
  ];
  const eff = analyzeEfficiency(lines);
  assert.equal(eff.network.tokened, 3);
  assert.equal(eff.network.justOrigin, 1);
  assert.equal(eff.network.catchall, 1);
  assert.equal(eff.cosmetic.green, 1);
  assert.equal(eff.cosmetic.amber, 1);
  assert.equal(eff.cosmetic.red, 1);
  assert.equal(eff.html_filters, 1);
  assert.equal(eff.scriptlets, 1);
  assert.equal(eff.responseheaders, 0);
  assert.equal(eff.network.grade, gradeOf(eff.network.score));
  assert.ok(eff.network.score > eff.cosmetic.score);
});

test('gradeOf bands scores', () => {
  assert.equal(gradeOf(1), 'A+');
  assert.equal(gradeOf(0.99), 'A');
  assert.equal(gradeOf(0.95), 'A-');
  assert.equal(gradeOf(0.9), 'B+');
  assert.equal(gradeOf(0.85), 'B');
  assert.equal(gradeOf(0.8), 'B-');
  assert.equal(gradeOf(0.7), 'C+');
  assert.equal(gradeOf(0.6), 'C');
  assert.equal(gradeOf(0.55), 'D');
  assert.equal(gradeOf(0.1), 'F');
});