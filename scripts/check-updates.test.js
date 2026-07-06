'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test: { compareVersions } } = require('../packages/copilot-termux/lib/check-updates.js');

test('compareVersions - fork revision comparison', async (t) => {
  await t.test('should treat -N suffix as fork revision (1.0.68 < 1.0.68-1)', () => {
    const result = compareVersions('1.0.68', '1.0.68-1');
    assert.ok(result < 0, `compareVersions('1.0.68', '1.0.68-1') should be < 0, got ${result}`);
  });

  await t.test('should compare revision numbers correctly (1.0.68-1 < 1.0.68-2)', () => {
    const result = compareVersions('1.0.68-1', '1.0.68-2');
    assert.ok(result < 0, `compareVersions('1.0.68-1', '1.0.68-2') should be < 0, got ${result}`);
  });

  await t.test('should return 0 for equal versions (1.0.68-1 === 1.0.68-1)', () => {
    const result = compareVersions('1.0.68-1', '1.0.68-1');
    assert.equal(result, 0, `compareVersions('1.0.68-1', '1.0.68-1') should be === 0, got ${result}`);
  });

  await t.test('should compare different base versions (1.0.65-1 < 1.0.68)', () => {
    const result = compareVersions('1.0.65-1', '1.0.68');
    assert.ok(result < 0, `compareVersions('1.0.65-1', '1.0.68') should be < 0, got ${result}`);
  });

  await t.test('should compare different major versions (1.0.69 > 1.0.68-9)', () => {
    const result = compareVersions('1.0.69', '1.0.68-9');
    assert.ok(result > 0, `compareVersions('1.0.69', '1.0.68-9') should be > 0, got ${result}`);
  });

  await t.test('should handle multi-digit revision numbers (1.0.68-10 > 1.0.68-2)', () => {
    const result = compareVersions('1.0.68-10', '1.0.68-2');
    assert.ok(result > 0, `compareVersions('1.0.68-10', '1.0.68-2') should be > 0, got ${result}`);
  });

  await t.test('should return 0 for identical versions without suffix (1.0.68 === 1.0.68)', () => {
    const result = compareVersions('1.0.68', '1.0.68');
    assert.equal(result, 0, `compareVersions('1.0.68', '1.0.68') should be === 0, got ${result}`);
  });
});
