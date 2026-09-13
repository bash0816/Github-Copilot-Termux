'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreTags } = require('./retag-latest-dist-tags.js');

test('retag-latest-dist-tags: restoreTags', async (t) => {
  await t.test('restores both tags successfully', () => {
    const calls = [];
    const result = restoreTags('1.0.0', '1.1.0', {
      addDistTag: (v, tag) => calls.push(['add', v, tag]),
      removeDistTag: (tag) => calls.push(['rm', tag]),
    });
    assert.deepEqual(result, { ok: true, failures: [] });
    assert.deepEqual(calls, [['add', '1.0.0', 'latest'], ['add', '1.1.0', 'candidate']]);
  });

  await t.test('records failure when latest restore fails', () => {
    const result = restoreTags('1.0.0', '1.1.0', {
      addDistTag: (v, tag) => { if (tag === 'latest') throw new Error('latest fail'); },
      removeDistTag: () => {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures[0].tag, 'latest');
  });

  await t.test('records failure when candidate restore fails', () => {
    const result = restoreTags('1.0.0', '1.1.0', {
      addDistTag: (v, tag) => { if (tag === 'candidate') throw new Error('candidate fail'); },
      removeDistTag: () => {},
    });
    assert.equal(result.failures[0].tag, 'candidate');
  });

  await t.test('records failure when candidate remove fails (no previous candidate)', () => {
    const result = restoreTags('1.0.0', '', {
      addDistTag: () => {},
      removeDistTag: () => { throw new Error('remove fail'); },
    });
    assert.equal(result.failures[0].target, '(remove)');
  });
});
