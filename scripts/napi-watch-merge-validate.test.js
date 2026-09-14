const test = require('node:test');
const assert = require('node:assert');
const { validateSafeMerge, deepEqual } = require('./napi-watch-merge-validate');

// Test deepEqual function
test('deepEqual: primitives and basics', () => {
  assert.strictEqual(deepEqual(1, 1), true);
  assert.strictEqual(deepEqual(1, 2), false);
  assert.strictEqual(deepEqual('a', 'a'), true);
  assert.strictEqual(deepEqual('a', 'b'), false);
  assert.strictEqual(deepEqual(true, true), true);
  assert.strictEqual(deepEqual(true, false), false);
});

test('deepEqual: null vs undefined vs object', () => {
  assert.strictEqual(deepEqual(null, null), true);
  assert.strictEqual(deepEqual(null, undefined), false);
  assert.strictEqual(deepEqual(null, {}), false);
  assert.strictEqual(deepEqual(undefined, undefined), true);
});

test('deepEqual: numbers with NaN/Infinity', () => {
  assert.strictEqual(deepEqual(NaN, NaN), false);
  assert.strictEqual(deepEqual(Infinity, Infinity), false);
  assert.strictEqual(deepEqual(-Infinity, -Infinity), false);
  assert.strictEqual(deepEqual(1.5, 1.5), true);
});

test('deepEqual: string vs number', () => {
  assert.strictEqual(deepEqual('1', 1), false);
  assert.strictEqual(deepEqual('1', '1'), true);
});

test('deepEqual: arrays', () => {
  assert.strictEqual(deepEqual([1, 2, 3], [1, 2, 3]), true);
  assert.strictEqual(deepEqual([1, 2, 3], [1, 2]), false);
  assert.strictEqual(deepEqual([1, 2, 3], [3, 2, 1]), false);
  assert.strictEqual(deepEqual([null, 'a'], [null, 'a']), true);
  assert.strictEqual(deepEqual([], []), true);
});

test('deepEqual: objects', () => {
  assert.strictEqual(deepEqual({ a: 1 }, { a: 1 }), true);
  assert.strictEqual(deepEqual({ a: 1 }, { a: 2 }), false);
  assert.strictEqual(deepEqual({ a: 1 }, { a: 1, b: 2 }), false);
  assert.strictEqual(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true);
  assert.strictEqual(deepEqual({}, {}), true);
});

test('deepEqual: nested structures', () => {
  const obj1 = { a: { b: [1, 2], c: null } };
  const obj2 = { a: { b: [1, 2], c: null } };
  const obj3 = { a: { b: [1, 2], c: undefined } };
  assert.strictEqual(deepEqual(obj1, obj2), true);
  assert.strictEqual(deepEqual(obj1, obj3), false);
});

// Test validateSafeMerge function
test('validateSafeMerge: disallowed file change', () => {
  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/package.json' },
    { status: 'A', path: 'packages/copilot-termux/new-file.js' }
  ];

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow: () => '{}',
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-abc'
  });

  assert.deepStrictEqual(result, { safeMerge: false, reason: 'disallowed_file_change' });
});

test('validateSafeMerge: platform-patch.js changed', () => {
  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/lib/platform-patch.js' }
  ];

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow: () => '{}',
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-abc'
  });

  assert.deepStrictEqual(result, { safeMerge: false, reason: 'code_or_audit_data_changed' });
});

test('validateSafeMerge: napi-known-exports.json changed', () => {
  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'config/napi-known-exports.json' }
  ];

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow: () => '{}',
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-abc'
  });

  assert.deepStrictEqual(result, { safeMerge: false, reason: 'code_or_audit_data_changed' });
});

test('validateSafeMerge: release-manifest unexpected change', () => {
  const baseManifest = {
    copilot_version: '1.2.2',
    last_updated: '2026-09-13',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null,
    other_field: 'preserve_me'
  };

  const headManifest = {
    copilot_version: '1.2.3',
    last_updated: '2026-09-14',
    candidate_state: 'pending', // unexpected change!
    canonical_package_status: 'not_published',
    latest_candidate_version: null,
    other_field: 'preserve_me'
  };

  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/config/copilot-termux-release-manifest.json' }
  ];

  const execGitShow = (ref, path) => {
    if (ref === 'origin/main') return JSON.stringify(baseManifest);
    return JSON.stringify(headManifest);
  };

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow,
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-abc'
  });

  assert.deepStrictEqual(result, { safeMerge: false, reason: 'unexpected_change_in_release_manifest' });
});

test('validateSafeMerge: config/manifest.json unexpected field change', () => {
  const releaseManifestBase = {
    copilot_version: '1.2.2',
    last_updated: '2026-09-13',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null
  };

  const releaseManifestHead = {
    copilot_version: '1.2.3',
    last_updated: '2026-09-14',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null
  };

  const packageJsonBase = {
    name: 'copilot-termux',
    version: '1.2.2'
  };

  const packageJsonHead = {
    name: 'copilot-termux',
    version: '1.2.3'
  };

  const configManifestBase = {
    copilot: { version: '1.2.2', integrity: 'sha512-old' },
    glibcNode: { version: '16.0.0' }
  };

  const configManifestHead = {
    copilot: { version: '1.2.3', integrity: 'sha512-new' },
    glibcNode: { version: '18.0.0' } // unexpected change!
  };

  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/config/copilot-termux-release-manifest.json' },
    { status: 'M', path: 'packages/copilot-termux/package.json' },
    { status: 'M', path: 'packages/copilot-termux/config/manifest.json' }
  ];

  const execGitShow = (ref, path) => {
    const isBase = ref === 'origin/main';
    if (path === 'packages/copilot-termux/config/copilot-termux-release-manifest.json') {
      return JSON.stringify(isBase ? releaseManifestBase : releaseManifestHead);
    }
    if (path === 'packages/copilot-termux/package.json') {
      return JSON.stringify(isBase ? packageJsonBase : packageJsonHead);
    }
    if (path === 'packages/copilot-termux/config/manifest.json') {
      return JSON.stringify(isBase ? configManifestBase : configManifestHead);
    }
    throw new Error('Unknown path: ' + path);
  };

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow,
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-new'
  });

  assert.deepStrictEqual(result, { safeMerge: false, reason: 'unexpected_change_in_config_manifest' });
});

test('validateSafeMerge: all three manifests valid', () => {
  const releaseManifestBase = {
    copilot_version: '1.2.2',
    last_updated: '2026-09-13',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null,
    metadata: 'preserve_me'
  };

  const releaseManifestHead = {
    copilot_version: '1.2.3',
    last_updated: '2026-09-14',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null,
    metadata: 'preserve_me'
  };

  const packageJsonBase = {
    name: 'copilot-termux',
    version: '1.2.2',
    description: 'test'
  };

  const packageJsonHead = {
    name: 'copilot-termux',
    version: '1.2.3',
    description: 'test'
  };

  const configManifestBase = {
    copilot: { version: '1.2.2', integrity: 'sha512-old' },
    glibcNode: { version: '16.0.0' }
  };

  const configManifestHead = {
    copilot: { version: '1.2.3', integrity: 'sha512-new' },
    glibcNode: { version: '16.0.0' }
  };

  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/config/copilot-termux-release-manifest.json' },
    { status: 'M', path: 'packages/copilot-termux/package.json' },
    { status: 'M', path: 'packages/copilot-termux/config/manifest.json' }
  ];

  const execGitShow = (ref, path) => {
    const isBase = ref === 'origin/main';
    if (path === 'packages/copilot-termux/config/copilot-termux-release-manifest.json') {
      return JSON.stringify(isBase ? releaseManifestBase : releaseManifestHead);
    }
    if (path === 'packages/copilot-termux/package.json') {
      return JSON.stringify(isBase ? packageJsonBase : packageJsonHead);
    }
    if (path === 'packages/copilot-termux/config/manifest.json') {
      return JSON.stringify(isBase ? configManifestBase : configManifestHead);
    }
    throw new Error('Unknown path: ' + path);
  };

  const result = validateSafeMerge({
    prHeadSha: 'abc123',
    newVersion: '1.2.3',
    expectedLastUpdated: '2026-09-14',
    execGitShow,
    execGitDiffNameStatus,
    fetchIntegrity: () => 'sha512-new'
  });

  assert.deepStrictEqual(result, { safeMerge: true, reason: 'matches_expected' });
});

test('validateSafeMerge: execGitShow throws', () => {
  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/package.json' }
  ];

  const execGitShow = () => {
    throw new Error('git show failed');
  };

  assert.throws(() => {
    validateSafeMerge({
      prHeadSha: 'abc123',
      newVersion: '1.2.3',
      expectedLastUpdated: '2026-09-14',
      execGitShow,
      execGitDiffNameStatus,
      fetchIntegrity: () => 'sha512-abc'
    });
  }, /git show failed/);
});

test('validateSafeMerge: fetchIntegrity throws', () => {
  const releaseManifestBase = {
    copilot_version: '1.2.2',
    last_updated: '2026-09-13',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null
  };

  const releaseManifestHead = {
    copilot_version: '1.2.3',
    last_updated: '2026-09-14',
    candidate_state: 'none',
    canonical_package_status: 'not_published',
    latest_candidate_version: null
  };

  const packageJsonBase = {
    name: 'copilot-termux',
    version: '1.2.2'
  };

  const packageJsonHead = {
    name: 'copilot-termux',
    version: '1.2.3'
  };

  const configManifestBase = {
    copilot: { version: '1.2.2', integrity: 'sha512-old' }
  };

  const configManifestHead = {
    copilot: { version: '1.2.3', integrity: 'sha512-new' }
  };

  const execGitDiffNameStatus = () => [
    { status: 'M', path: 'packages/copilot-termux/config/copilot-termux-release-manifest.json' },
    { status: 'M', path: 'packages/copilot-termux/package.json' },
    { status: 'M', path: 'packages/copilot-termux/config/manifest.json' }
  ];

  const execGitShow = (ref, path) => {
    const isBase = ref === 'origin/main';
    if (path === 'packages/copilot-termux/config/copilot-termux-release-manifest.json') {
      return JSON.stringify(isBase ? releaseManifestBase : releaseManifestHead);
    }
    if (path === 'packages/copilot-termux/package.json') {
      return JSON.stringify(isBase ? packageJsonBase : packageJsonHead);
    }
    if (path === 'packages/copilot-termux/config/manifest.json') {
      return JSON.stringify(isBase ? configManifestBase : configManifestHead);
    }
    throw new Error('Unknown path: ' + path);
  };

  const fetchIntegrity = () => {
    throw new Error('npm view failed');
  };

  assert.throws(() => {
    validateSafeMerge({
      prHeadSha: 'abc123',
      newVersion: '1.2.3',
      expectedLastUpdated: '2026-09-14',
      execGitShow,
      execGitDiffNameStatus,
      fetchIntegrity
    });
  }, /npm view failed/);
});
