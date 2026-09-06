import test from 'node:test';
import assert from 'node:assert/strict';
import { subsume, subsumeScoped, parseSimpleRule, countWildcardDomainRules } from '../src/network.js';

const run = (lines) => subsume(lines.map(String));

test('parses candidates', () => {
  for (const [raw, host, path] of [
    ['||example.com^', 'example.com', ''],
    ['||example.com/foo^', 'example.com', 'foo'],
    ['||a.b.co.uk/path/to^', 'a.b.co.uk', 'path/to'],
    ['||123.abc-xyz.com^', '123.abc-xyz.com', ''],
  ]) {
    assert.equal(parseSimpleRule(raw).host, host, `host of ${raw}`);
    assert.equal(parseSimpleRule(raw).path, path, `path of ${raw}`);
  }
});

test('rejects non-candidates', () => {
  for (const raw of [
    '@@||example.com^',
    '||example.com^$script',
    '||example.com*^',
    '||example.com^/foo*bar',
    '||ExAmPlE.com^',
    '||exa_mple.com^',
    '||example.com^/foo',
    'example.com',
    '||example.com^/foo^bar',
    '||example.*^',
  ]) {
    assert.equal(parseSimpleRule(raw), null, `should reject ${raw}`);
  }
});

test('parent host covers child', () => {
  const [kept, removed] = run([
    '||example.com^',
    '||www.example.com^',
    '||sub.www.example.com^',
    '||unrelated.com^',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com^', '||unrelated.com^']);
});

test('path prefix covers same host', () => {
  const [kept, removed] = run([
    '||example.com/foo^',
    '||example.com/foo/bar^',
    '||example.com/foo/bar/baz^',
    '||example.com/foobar^',
    '||example.com/other^',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com/foo^', '||example.com/foobar^', '||example.com/other^']);
});

test('combined host suffix and path prefix', () => {
  const [kept, removed] = run([
    '||example.com/ads^',
    '||www.example.com/ads/banner^',
    '||example.com/ads/x^',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com/ads^']);
});

test('host only covers any path', () => {
  const [kept, removed] = run([
    '||example.com^',
    '||example.com/some/path^',
    '||www.example.com/other^',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com^']);
});

test('unrelated hosts and paths kept', () => {
  const lines = [
    '||a.com/x^',
    '||a.com/y^',
    '||b.com^',
    '||c.com/x/y^',
    '||c.com/y/x^',
    '||sub.d.com/x^',
  ];
  const [kept, removed] = run(lines);
  assert.equal(removed, 0);
  assert.deepEqual(kept, lines);
});

test('single label suffix covers', () => {
  const [kept, removed] = run(['||com^', '||example.com^', '||www.example.com/foo^']);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||com^']);
});

test('exceptions and option rules never participate', () => {
  const lines = [
    '@@||example.com^',
    '@@||www.example.com^',
    '||example.com^$script',
    '||example.com^$domain=example.org',
    '||example.com^',
  ];
  const [kept, removed] = run(lines);
  assert.equal(removed, 0);
  assert.deepEqual(kept, lines);
});

test('maximal set removes chains', () => {
  const [kept, removed] = run(['||a.com/b^', '||a.com/b/c^', '||sub.a.com/b/c/d^']);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||a.com/b^']);
});

test('leaves non-candidates alone', () => {
  const lines = [
    '||example.com^/foo*bar^',
    'example.com',
    '||a.com^$all',
    '! comment',
    '##.ad',
  ];
  const [kept, removed] = run(lines);
  assert.equal(removed, 0);
  assert.deepEqual(kept, lines);
});

test('badfilter base rule not used for subsumption', () => {
  const [kept] = run([
    '||totaladblock.com^',
    '||totaladblock.com^$badfilter',
    '||totaladblock.com^$document',
    '||totaladblock.com^$document,badfilter',
    '||www.totaladblock.com^',
  ]);
  assert.ok(kept.includes('||www.totaladblock.com^'));
  assert.ok(!kept.includes('||totaladblock.com^'));
});

test('badfilter with options only cancels matching base', () => {
  const [kept] = run([
    '||example.com^$document',
    '||example.com^$document,badfilter',
    '||example.com^$script',
  ]);
  assert.ok(kept.includes('||example.com^$script'));
  assert.ok(!kept.includes('||example.com^$document'));
});

test('case insensitive coverage', () => {
  const [kept, removed] = run([
    '||example.com/Foo^',
    '||example.com/foo/bar^',
    '||www.example.com/foo^',
  ]);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com/Foo^']);
});

test('bare host caret preffered over slash', () => {
  const [kept, removed] = run(['||example.com/', '||example.com^']);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['||example.com^']);

  const [kept2, removed2] = run([
    '||example.com/path/',
    '||example.com/path^',
    '||sub.example.com/path^',
  ]);
  assert.equal(removed2, 2);
  assert.deepEqual(kept2, ['||example.com/path^']);
});

test('wildcard tld domain rules counted', () => {
  const lines = [
    '*$3p,script,domain=streamgoto.*',
    '||html-load.com/$script,domain=a.com|b.*',
    '||example.com^$domain=example.com',
    '||example.com^',
  ];
  assert.equal(countWildcardDomainRules(lines), 2);
});

test('scoped rule removed when optionless exists', () => {
  const input = ['||example.com/ads^', '||example.com/ads^$script', '||example.com/ads^$image'];
  const [kept, removed] = subsumeScoped(input);
  assert.equal(removed, 2);
  assert.deepEqual(kept, ['||example.com/ads^']);
});

test('scoped rule kept when no optionless counterpart', () => {
  const input = ['||example.com/ads^$script'];
  const [kept, removed] = subsumeScoped(input);
  assert.equal(removed, 0);
  assert.deepEqual(kept, input);
});

test('document option not subsumed', () => {
  const input = ['||example.com/ads^', '||example.com/ads^$document'];
  const [kept, removed] = subsumeScoped(input);
  assert.equal(removed, 0);
  assert.deepEqual(kept, input);
});

test('popup option not subsumed in uBO', () => {
  // Verified against SNFE: uBO optionless `||host/path^` does NOT match the
  // `popup` request type, so `$popup` must survive.
  const input = ['||example.com/ads^', '||example.com/ads^$popup'];
  const [kept, removed] = subsumeScoped(input);
  assert.equal(removed, 0);
  assert.deepEqual(kept, input);
});

test('party constraint subsumed', () => {
  const input = ['||example.com/ads^', '||example.com/ads^$third-party'];
  const [kept, removed] = subsumeScoped(input);
  assert.equal(removed, 1);
  assert.deepEqual(kept, ['||example.com/ads^']);
});