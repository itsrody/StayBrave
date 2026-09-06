import test from 'node:test';
import assert from 'node:assert/strict';
import { expandConditionals, evalIfExpression, tokenTruth } from '../src/preprocess.js';

test('token truth table matches desktop Firefox uBO', () => {
  assert.equal(tokenTruth('ext_ublock').truth, true);
  assert.equal(tokenTruth('env_firefox').truth, true);
  assert.equal(tokenTruth('cap_html_filtering').truth, true);
  assert.equal(tokenTruth('cap_user_stylesheet').truth, true);
  assert.equal(tokenTruth('cap_ipaddress').truth, true);
  assert.equal(tokenTruth('env_chromium').truth, false);
  assert.equal(tokenTruth('env_mobile').truth, false);
  assert.equal(tokenTruth('env_mv3').truth, false);
  assert.equal(tokenTruth('env_safari').truth, false);
  assert.equal(tokenTruth('ext_ubol').truth, false);
  assert.equal(tokenTruth('ext_abp').truth, false);
  assert.equal(tokenTruth('unknown_token').truth, false);
  assert.equal(tokenTruth('!env_mobile').truth, true);
});

test('adguard-compat tokens', () => {
  // uBO maps adguard_ext_firefox to the firefox env value.
  assert.equal(tokenTruth('adguard_ext_firefox').truth, true);
  assert.equal(tokenTruth('adguard_ext_chromium').truth, false);
  assert.equal(tokenTruth('adguard_app_ios').truth, false);
});

test('evalIfExpression precedence and negation', () => {
  assert.equal(evalIfExpression('ext_ublock'), true);
  assert.equal(evalIfExpression('!ext_ublock'), false);
  assert.equal(evalIfExpression('ext_ublock && !env_mobile'), true);
  assert.equal(evalIfExpression('ext_ublock && env_mobile'), false);
  assert.equal(evalIfExpression('ext_ublock || env_mobile'), true);
  assert.equal(evalIfExpression('unknown || ext_ublock'), true);
  assert.equal(evalIfExpression('unknown && ext_ublock'), false);
  assert.equal(evalIfExpression('(adguard_ext_firefox)'), true);
});

test('scans out inactive branches', () => {
  const text = [
    '! A',
    '!#if env_mobile',
    '||mobile.example.com^',
    '!#else',
    '||desktop.example.com^',
    '!#endif',
    '!#if env_firefox',
    '||ff.example.com^',
    '!#endif',
    '##.always',
  ].join('\n');
  const out = expandConditionals(text);
  assert.ok(out.includes('||desktop.example.com^'), 'else branch kept');
  assert.ok(!out.includes('||mobile.example.com^'), 'dead branch dropped');
  assert.ok(out.includes('||ff.example.com^'));
  assert.ok(out.includes('##.always'));
  assert.ok(!out.includes('!#if') && !out.includes('!#endif'));
});

test('nested blocks', () => {
  const text = [
    '!#if ext_ublock',
    '!#if env_chromium',
    '||chromium.example.com^',
    '!#else',
    '||bull.example.com^',
    '!#endif',
    '!#endif',
    '##.x',
  ].join('\n');
  const out = expandConditionals(text);
  assert.ok(out.includes('||bull.example.com^'));
  assert.ok(!out.includes('||chromium.example.com^'));
});

test('unbalanced if throws', () => {
  assert.throws(() => expandConditionals('!#if ext_ublock\n##.x\n'));
});