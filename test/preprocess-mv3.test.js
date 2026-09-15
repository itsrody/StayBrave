import test from 'node:test';
import assert from 'node:assert/strict';
import { expandConditionals, evalIfExpression, tokenTruth, MV3_ENV } from '../src/preprocess.js';

test('MV3_ENV truth table matches uBO Lite', () => {
  const env = MV3_ENV;
  const t = (tok) => tokenTruth(tok, env).truth;
  assert.equal(t('ext_ublock'), true);
  assert.equal(t('ext_ubol'), true);
  assert.equal(t('env_chromium'), true);
  assert.equal(t('env_mv3'), true);
  assert.equal(t('adguard_ext_chromium'), true);
  assert.equal(t('env_firefox'), false);
  assert.equal(t('cap_html_filtering'), false);
  assert.equal(t('cap_user_stylesheet'), false);
  assert.equal(t('cap_ipaddress'), false);
  assert.equal(t('env_safari'), false);
  assert.equal(t('env_legacy'), false);
  assert.equal(t('ext_abp'), false);
  assert.equal(t('adguard_ext_firefox'), false);
});

test('evalIfExpression in MV3 env prefers mv3/chromium branches', () => {
  const env = MV3_ENV;
  assert.equal(evalIfExpression('env_mv3', env), true);
  assert.equal(evalIfExpression('env_chromium', env), true);
  assert.equal(evalIfExpression('!env_firefox', env), true);
  assert.equal(evalIfExpression('env_firefox', env), false);
  assert.equal(evalIfExpression('env_mv3 && !env_firefox', env), true);
});

test('expandConditionals keeps mv3 branches in the MV3 env', () => {
  const text = [
    '||always.com^',
    '!#if env_mv3',
    '||mv3-only.com^',
    '!#else',
    '||firefox-only.com^',
    '!#endif',
    '!#if env_firefox',
    '||ff.com^',
    '!#endif',
    '||always2.com^',
  ].join('\n');
  const mv3 = expandConditionals(text, MV3_ENV);
  assert.ok(mv3.includes('||mv3-only.com^'));
  assert.ok(!mv3.includes('||firefox-only.com^'));
  assert.ok(!mv3.includes('||ff.com^'));
  assert.ok(mv3.includes('||always.com^'));
});