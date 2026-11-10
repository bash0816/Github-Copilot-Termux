'use strict';

// copilot update の結合テスト（sh launcher -> check-updates.js update -> npm -> setup）。
// 実行には COPILOT_TERMUX_INTEGRATION=1 が必要。未指定時は全件 skip し、何も作成しない。
// 各テストは一時ディレクトリ（パスに空白を含む）を作り、finally で削除する。
// npm は一時ディレクトリの fake npm に差し替える。実 HOME・グローバル npm には触れない。
// 登録簿の最新版取得（registry.npmjs.org）を行うケースがあるため、ネットワークが必要。

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { __test: { compareVersions } } = require('../packages/copilot-termux/lib/check-updates.js');

const SKIP = process.env.COPILOT_TERMUX_INTEGRATION === '1'
  ? false
  : 'set COPILOT_TERMUX_INTEGRATION=1 to run (uses a temp dir and the npm registry)';

const PKG_SRC = path.resolve(__dirname, '../packages/copilot-termux');
const TEST_OPTS = { skip: SKIP, timeout: 180000 };

function makeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cp update ')));
  const prefix = path.join(root, 'prefix');
  const pkgDir = path.join(prefix, 'lib', 'node_modules', '@bash0816', 'copilot-termux');
  const fx = {
    root,
    prefix,
    pkgDir,
    home: path.join(root, 'home'),
    fakebin: path.join(root, 'fakebin'),
    fakeNpm: path.join(root, 'fakebin', 'npm'),
    npmArgs: path.join(root, 'npm-args.txt'),
    setupCalls: path.join(root, 'setup-calls.txt'),
    blockNet: path.join(root, 'block-net.js'),
    launcher: path.join(prefix, 'bin', 'copilot'),
    setupBin: path.join(prefix, 'bin', 'copilot-termux'),
  };
  try {
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.mkdirSync(fx.home);
    fs.mkdirSync(fx.fakebin);
    for (const name of ['bin', 'lib', 'config']) {
      fs.cpSync(path.join(PKG_SRC, name), path.join(pkgDir, name), { recursive: true });
    }
    fs.copyFileSync(path.join(PKG_SRC, 'README.md'), path.join(pkgDir, 'README.md'));
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@bash0816/copilot-termux', version: '1.0.0', bin: { 'copilot-termux': 'bin/copilot-termux' } }, null, 2) + '\n',
    );
    fs.symlinkSync(path.join(pkgDir, 'bin', 'copilot'), fx.launcher);
    fs.symlinkSync(path.join(pkgDir, 'bin', 'copilot-termux'), fx.setupBin);
  } catch (e) {
    fs.rmSync(root, { recursive: true, force: true });
    throw e;
  }
  return fx;
}

function cleanup(fx) {
  fs.rmSync(fx.root, { recursive: true, force: true });
}

// fake npm: 引数を 1 行ずつ記録し、成功時は setup の代わりに記録用スクリプトを置く。
function writeFakeNpm(fx) {
  const q = (p) => `"${p}"`;
  const lines = [
    '#!/bin/sh',
    'set -eu',
    'for a in "$@"; do',
    `  printf '%s\\n' "$a" >> ${q(fx.npmArgs)}`,
    'done',
    'if [ -n "${FAKE_NPM_STATUS:-}" ] && [ "${FAKE_NPM_STATUS}" != "0" ]; then',
    '  exit "${FAKE_NPM_STATUS}"',
    'fi',
    `rm -f ${q(fx.setupBin)}`,
    `cat > ${q(fx.setupBin)} <<'FAKE_SETUP_EOF'`,
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${q(fx.setupCalls)}`,
    'exit "${FAKE_SETUP_STATUS:-0}"',
    'FAKE_SETUP_EOF',
    `chmod 0755 ${q(fx.setupBin)}`,
    'exit 0',
    '',
  ];
  fs.writeFileSync(fx.fakeNpm, lines.join('\n'), { mode: 0o755 });
  fs.chmodSync(fx.fakeNpm, 0o755);
}

// ネットワークを ECONNREFUSED で失敗させる preload（オフライン再現用）。
function writeBlockNet(fx) {
  const lines = [
    "'use strict';",
    "const EventEmitter = require('events');",
    "const https = require('https');",
    "const net = require('net');",
    "const tls = require('tls');",
    'function fail() {',
    '  const req = new EventEmitter();',
    '  req.destroy = function () { return this; };',
    '  req.setTimeout = function () { return this; };',
    '  req.end = function () { return this; };',
    '  req.write = function () { return true; };',
    '  process.nextTick(() => {',
    "    const e = new Error('connect ECONNREFUSED (blocked by integration test)');",
    "    e.code = 'ECONNREFUSED';",
    "    req.emit('error', e);",
    '  });',
    '  return req;',
    '}',
    'https.get = fail;',
    'https.request = fail;',
    'net.connect = fail;',
    'net.createConnection = fail;',
    'tls.connect = fail;',
    '',
  ];
  fs.writeFileSync(fx.blockNet, lines.join('\n'));
}

function buildEnv(fx, extraEnv = {}) {
  const env = { ...process.env };
  for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'FAKE_NPM_STATUS', 'FAKE_SETUP_STATUS']) delete env[k];
  Object.assign(env, extraEnv, {
    PATH: `${fx.fakebin}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    HOME: fx.home,
  });
  return env;
}

function runLauncher(fx, args, extraEnv = {}) {
  const r = cp.spawnSync('sh', [fx.launcher, ...args], {
    env: buildEnv(fx, extraEnv),
    encoding: 'utf8',
    timeout: 120000,
  });
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error };
}

function readLines(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '');
}

test('copilot update: npm 成功後に setup が呼ばれ、exit 0 になる', TEST_OPTS, () => {
  const fx = makeFixture();
  try {
    writeFakeNpm(fx);
    const r = runLauncher(fx, ['update']);
    const npmArgs = readLines(fx.npmArgs);
    // fake npm が動いていない場合、実 npm が動いた可能性がある。ここで停止して報告する。
    assert.notEqual(npmArgs, null, `npm-args.txt がない（fake npm が呼ばれていない）。stderr: ${r.stderr}`);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(npmArgs.length, 5, JSON.stringify(npmArgs));
    assert.deepEqual(npmArgs.slice(0, 4), ['install', '-g', '--prefix', fx.prefix]);
    const m = /^@bash0816\/copilot-termux@(\d+\.\d+\.\d+(?:-\d+)?)$/.exec(npmArgs[4]);
    assert.ok(m, `spec が想定外: ${npmArgs[4]}`);
    assert.ok(compareVersions(m[1], '1.0.0') > 0, `1.0.0 より新しい版を指定すること: ${m[1]}`);
    assert.deepEqual(readLines(fx.setupCalls), ['setup']);
    assert.ok(r.stderr.includes(`Updated to ${m[1]}.`), r.stderr);
  } finally {
    cleanup(fx);
  }
});

test('copilot update: npm が失敗すると exit 1、setup は呼ばれない', TEST_OPTS, () => {
  const fx = makeFixture();
  try {
    writeFakeNpm(fx);
    const r = runLauncher(fx, ['update'], { FAKE_NPM_STATUS: '1' });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('Update failed. Run manually:'), r.stderr);
    assert.notEqual(readLines(fx.npmArgs), null, 'fake npm が呼ばれていない');
    assert.equal(readLines(fx.setupCalls), null, 'npm 失敗時に setup が呼ばれた');
  } finally {
    cleanup(fx);
  }
});

test('copilot update: setup が status 3 で失敗すると exit 3 を返す', TEST_OPTS, () => {
  const fx = makeFixture();
  try {
    writeFakeNpm(fx);
    const r = runLauncher(fx, ['update'], { FAKE_SETUP_STATUS: '3' });
    assert.equal(r.status, 3, r.stderr);
    assert.ok(r.stderr.includes('The package was updated to'), r.stderr);
    assert.ok(r.stderr.includes('Run: copilot-termux setup'), r.stderr);
    assert.deepEqual(readLines(fx.setupCalls), ['setup']);
  } finally {
    cleanup(fx);
  }
});

test('copilot update --dry-run: npm も setup も実行せず、コマンドを表示する', TEST_OPTS, () => {
  const fx = makeFixture();
  try {
    writeFakeNpm(fx);
    const r = runLauncher(fx, ['update', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(
      r.stdout.includes(`npm install -g --prefix ${fx.prefix} @bash0816/copilot-termux@`),
      r.stdout,
    );
    assert.ok(r.stdout.includes(`${fx.prefix}/bin/copilot-termux setup`), r.stdout);
    assert.equal(readLines(fx.npmArgs), null, '--dry-run で npm が呼ばれた');
    assert.equal(readLines(fx.setupCalls), null, '--dry-run で setup が呼ばれた');
  } finally {
    cleanup(fx);
  }
});

test('copilot update: registry に届かない場合は exit 1、npm は呼ばれない', TEST_OPTS, () => {
  const fx = makeFixture();
  try {
    writeFakeNpm(fx);
    writeBlockNet(fx);
    const netEnv = { NODE_OPTIONS: `--require "${fx.blockNet}"` };

    // 前提確認: この env で https.get が ECONNREFUSED になること。
    const probe = cp.spawnSync(
      process.execPath,
      [
        '-e',
        "const https=require('https');https.get('https://registry.npmjs.org/',()=>process.exit(0)).on('error',e=>{console.log(e.code);process.exit(7);});",
      ],
      { env: buildEnv(fx, netEnv), encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(probe.status, 7, `preload が効いていない: status=${probe.status} stderr=${probe.stderr}`);
    assert.equal(probe.stdout.trim(), 'ECONNREFUSED');

    const r = runLauncher(fx, ['update'], netEnv);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('Failed to check for updates'), r.stderr);
    assert.ok(r.stderr.includes('After installing, run: copilot-termux setup'), r.stderr);
    assert.equal(readLines(fx.npmArgs), null, '登録簿取得失敗時に npm が呼ばれた');
  } finally {
    cleanup(fx);
  }
});
