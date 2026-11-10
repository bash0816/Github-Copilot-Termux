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

const cp = require('child_process');
const path = require('path');
const { __test: { installVersion } } = require('../packages/copilot-termux/lib/check-updates.js');

// installVersion と同じ方法で npmPrefix / setupBin を求める（source: lib/check-updates.js の 17・110 行）
const libDir = path.resolve(__dirname, '../packages/copilot-termux/lib');
const expectedPrefix = path.resolve(libDir, '../../../../..');
const expectedSetupBin = path.join(expectedPrefix, 'bin', 'copilot-termux');
const TARGET_VER = '1.0.107';
const PKG_SPEC = `@bash0816/copilot-termux@${TARGET_VER}`;

// spawnSync をスタブ化して installVersion を実行する。想定外の呼び出しは例外にする。
function runInstall({ spawnImpl, dryRun = false }) {
  const origSpawn = cp.spawnSync;
  const origLog = console.log;
  const origErr = console.error;
  const origArgv = process.argv;
  const calls = [];
  const out = [];
  const err = [];
  cp.spawnSync = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawnImpl(calls.length, cmd, args, opts);
  };
  console.log = (...a) => { out.push(a.join(' ')); };
  console.error = (...a) => { err.push(a.join(' ')); };
  if (dryRun) process.argv = [...origArgv, '--dry-run'];
  try {
    const ret = installVersion(TARGET_VER);
    return { ret, calls, out: out.join('\n'), err: err.join('\n') };
  } finally {
    cp.spawnSync = origSpawn;
    console.log = origLog;
    console.error = origErr;
    process.argv = origArgv;
  }
}

const unexpected = () => { throw new Error('unexpected spawnSync call'); };

test('installVersion - npm install then setup', async (t) => {
  await t.test('npm 0 and setup 0 return 0, call order npm then setup, no shell', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: 0 } : n === 2 ? { status: 0 } : unexpected()),
    });
    assert.equal(r.ret, 0);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[0].cmd, 'npm');
    assert.deepEqual(r.calls[0].args, ['install', '-g', '--prefix', expectedPrefix, PKG_SPEC]);
    assert.equal(r.calls[1].cmd, expectedSetupBin);
    assert.deepEqual(r.calls[1].args, ['setup']);
    assert.deepEqual(r.calls[1].opts, { stdio: 'inherit' });
    assert.ok(r.err.includes(`Updated to ${TARGET_VER}.`), r.err);
  });

  await t.test('npm status 1 returns 1, setup not called, manual command shown', () => {
    const r = runInstall({ spawnImpl: (n) => (n === 1 ? { status: 1 } : unexpected()) });
    assert.equal(r.ret, 1);
    assert.equal(r.calls.length, 1);
    assert.ok(r.err.includes(`DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix ${expectedPrefix} ${PKG_SPEC}`), r.err);
    assert.ok(r.err.includes('After installing, run: copilot-termux setup'), r.err);
  });

  await t.test('npm killed by signal (status null) returns 1, setup not called', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: null, signal: 'SIGTERM' } : unexpected()),
    });
    assert.equal(r.ret, 1);
    assert.equal(r.calls.length, 1);
  });

  await t.test('setup status 3 returns 3 with recovery message', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: 0 } : n === 2 ? { status: 3 } : unexpected()),
    });
    assert.equal(r.ret, 3);
    assert.ok(r.err.includes(`The package was updated to ${TARGET_VER}, but updating the copilot binary failed.`), r.err);
    assert.ok(r.err.includes('Run: copilot-termux setup'), r.err);
  });

  await t.test('setup spawn error (ENOENT) returns 1 and prints error message', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: 0 } : n === 2 ? { error: new Error('ENOENT'), status: null } : unexpected()),
    });
    assert.equal(r.ret, 1);
    assert.ok(r.err.includes(`The package was updated to ${TARGET_VER}, but updating the copilot binary failed.`), r.err);
    assert.ok(r.err.includes('Run: copilot-termux setup'), r.err);
    assert.ok(r.err.includes('ENOENT'), r.err);
  });

  await t.test('setup killed by signal returns nonzero', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: 0 } : n === 2 ? { status: null, signal: 'SIGTERM' } : unexpected()),
    });
    assert.notEqual(r.ret, 0);
    assert.ok(r.err.includes('but updating the copilot binary failed'), r.err);
  });

  await t.test('--dry-run never calls spawnSync and prints both commands', () => {
    const r = runInstall({ spawnImpl: unexpected, dryRun: true });
    assert.equal(r.ret, 0);
    assert.equal(r.calls.length, 0);
    assert.ok(r.out.includes(`npm install -g --prefix ${expectedPrefix} ${PKG_SPEC}`), r.out);
    assert.ok(r.out.includes(`${expectedSetupBin} setup`), r.out);
  });

  await t.test('npm argv keeps npmPrefix as a single element', () => {
    const r = runInstall({
      spawnImpl: (n) => (n === 1 ? { status: 0 } : n === 2 ? { status: 0 } : unexpected()),
    });
    assert.equal(r.calls[0].args.length, 5);
    assert.equal(r.calls[0].args[3], expectedPrefix);
  });
});
