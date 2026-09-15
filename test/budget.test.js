import test from 'node:test';
import assert from 'node:assert/strict';
import { trimToBudget, isCosmeticLine, isExceptionLine, blockingRank } from '../src/budget.js';

test('classifies cosmetic and exception lines', () => {
  assert.equal(isCosmeticLine('example.com##.ad'), true);
  assert.equal(isCosmeticLine('example.com#@#.ad'), true);
  assert.equal(isCosmeticLine('||ads.com^'), false);
  assert.equal(isExceptionLine('@@||ads.com^$document'), true);
  assert.equal(isExceptionLine('example.com#@#.ad'), true);
  assert.equal(isExceptionLine('||ads.com^'), false);
});

test('no trim when under budget', () => {
  const lines = ['||a.com^', '||b.com^', '##.ad'];
  const r = trimToBudget(lines, { budget: 10 });
  assert.deepEqual(r.rules, lines);
  assert.equal(r.dropped, 0);
});

test('cosmetics never count toward the network budget', () => {
  const lines = ['##.ad', 'a.com##.x', '||a.com^'];
  const r = trimToBudget(lines, { budget: 1 });
  // 1 network rule <= budget -> untouched
  assert.deepEqual(r.rules, lines);
  assert.equal(r.dropped, 0);
  assert.equal(r.network, 1);
});

test('exceptions are reserved, never pruned', () => {
  const lines = ['||a.com^', '||b.com^', '@@||c.com^'];
  const r = trimToBudget(lines, {
    budget: 2,
    priorityOf: (l) => (l === '||a.com^' ? 5 : l === '||b.com^' ? 1 : 3),
  });
  // exceptions = 1, so 1 blocking slot; a.com^ (priority 5) survives.
  assert.deepEqual(r.rules, ['@@||c.com^', '||a.com^']);
  assert.equal(r.dropped, 1);
  assert.equal(r.exceptions, 1);
});

test('higher-priority blocking rules survive first', () => {
  const lines = ['||a.com^', '||b.com^', '||c.com^', '||d.com^'];
  const priorityOf = (l) => ({
    '||a.com^': 5,
    '||b.com^': 4,
    '||c.com^': 2,
    '||d.com^': 1,
  })[l];
  const r = trimToBudget(lines, { budget: 2, priorityOf });
  assert.deepEqual(r.rules, ['||a.com^', '||b.com^']);
  assert.equal(r.dropped, 2);
  assert.deepEqual(r.dropped_by_priority, { 1: 1, 2: 1 });
});

test('default priority is 3 and output stays sorted', () => {
  const lines = ['||a.com^', '||b.com^', '||c.com^', '||d.com^'];
  const r = trimToBudget(lines, { budget: 2 });
  assert.equal(r.rules.length, 2);
  assert.deepEqual(r.rules, [...r.rules].sort());
  assert.equal(r.dropped, 2);
});

test('within a priority band, domain-anchored blocking rules survive before bare patterns', () => {
  const lines = [
    '&foo=tracker&',
    '||ads.example.com^',
    '||also.example.net^',
    '%2Fbeacon%3F',
    '/tracker/pixel',
  ];
  assert.equal(blockingRank('||ads.example.com^'), 2);
  assert.equal(blockingRank('/tracker/pixel'), 1);
  assert.equal(blockingRank('&foo=tracker&'), 0);
  const r = trimToBudget(lines, { budget: 2 });
  // The two host-anchored rules survive; the bare patterns are pruned.
  assert.deepEqual(r.rules, ['||ads.example.com^', '||also.example.net^']);
  assert.equal(r.dropped, 3);
});

test('source priority still beats the coverage tiebreak', () => {
  const lines = ['&foo=1', '||z.com^'];
  // The bare pattern comes from a priority-5 list, the host rule from p1.
  const r = trimToBudget(lines, {
    budget: 1,
    priorityOf: (l) => (l === '&foo=1' ? 5 : 1),
  });
  assert.deepEqual(r.rules, ['&foo=1']);
});