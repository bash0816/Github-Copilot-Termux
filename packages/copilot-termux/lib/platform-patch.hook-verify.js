#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

// テストスイート実装
const tests = [];
let passCount = 0;
let failCount = 0;

function assert(condition, message) {
  if (!condition) {
    tests.push({ name: message, passed: false });
    failCount++;
    console.error(`  FAIL: ${message}`);
  } else {
    tests.push({ name: message, passed: true });
    passCount++;
    console.log(`  PASS: ${message}`);
  }
}

// Termux環境対応: $TMPDIR を使用
// テスト用構造: $TMPDIR/test-verify-xxx/.copilot-termux/1.0.65/{package.json,app.js,index.js}
//               $TMPDIR/test-verify-xxx/.copilot-termux/current -> 1.0.65 (symlink)
// package.json に "type":"module" を含めることで実物の ESM ロード条件を再現する。
const tempBase = path.join(process.env.TMPDIR || '/tmp', `test-verify-${Date.now().toString(36)}`);
const verifyDir = path.join(tempBase, '.copilot-termux');
const versionDir = path.join(verifyDir, '1.0.65');
const currentLink = path.join(verifyDir, 'current');
const appJsPath = path.join(versionDir, 'app.js');
const indexJsPath = path.join(versionDir, 'index.js');
const packageJsonPath = path.join(versionDir, 'package.json');

const platformPatchPath = path.join(__dirname, 'platform-patch.js');

console.log('[copilot-termux platform-patch.hook-verify]');
console.log(`Temp directory: ${verifyDir}`);
console.log('');

function cleanup() {
  console.log('\n[Cleanup] Removing test directory');
  try {
    try { fs.unlinkSync(currentLink); } catch (_) {}
    fs.rmSync(tempBase, { recursive: true, force: true });
    console.log('[Cleanup] Success');
  } catch (e) {
    console.error('[Cleanup] Failed:', e.message);
  }
}

try {
  // 1. テスト用ディレクトリ構造を作成（ESM: package.json に "type":"module" 必須）
  fs.mkdirSync(versionDir, { recursive: true });
  console.log('[Setup] Created version directory');

  fs.writeFileSync(packageJsonPath, JSON.stringify({
    name: '@github/copilot-test-fixture',
    version: '1.0.65',
    type: 'module',
  }, null, 2), 'utf8');
  console.log('[Setup] Created package.json (type: module)');

  // 2. 疑似 app.js を作成（UPDATE-001 と UPDATE-003 の両パターン含む、ESM構文）
  // UPDATE-004/005撤去の回帰確認用: upstream本来のchangelog fallback分岐
  // （旧CHANGELOG_FALLBACK_PATTERNがマッチしていた形）も含める。
  // このパターンは撤去後は一切書き換えられず、元のまま残ることを確認する。
  const CHANGELOG_FALLBACK_FIXTURE = 'if(!ELt.default.gt(u,a))return nj.execute(t,[a])';
  // UPDATE-006: DO()内のreleases/latest行（変数o,n）と、パッチ対象外のa$e()行（変数a,r）
  const UPDATE_006_DO_FIXTURE = 'return(await rF(o=>gR("GET /repos/{owner}/{repo}/releases/latest",{owner:"github",repo:"copilot-cli",headers:o}),n)).data';
  const UPDATE_006_ASE_FIXTURE = 'return(await rF(a=>gR("GET /repos/{owner}/{repo}/releases/latest",{owner:"github",repo:"copilot-cli",headers:a}),r)).data';
  const fakeAppJs = `// Minified ESM stub containing both patterns
export const WEr = function () { return \`npm i -g @github/copilot@\${someVar}\`; };
export const checkReleases = function (c) {
  x.gt(c.tag_name,y())&&(z.info(\`Update available: \${c.tag_name}\`),w.sendUpdateNotification(\`\${c.tag_name} available \\xB7 run /update\`))
};
export const runUpdateCommand = async (t, e) => {
  ${CHANGELOG_FALLBACK_FIXTURE};
};
export async function DO(t,e){let n=vkt(e);${UPDATE_006_DO_FIXTURE}}
export async function a$e(t,e){let r=vkt(e);${UPDATE_006_ASE_FIXTURE}}
`;
  fs.writeFileSync(appJsPath, fakeAppJs, 'utf8');
  console.log('[Setup] Created fake app.js (ESM)');

  // 3. 疑似 index.js（app.js を dynamic import する、本物の起動フローを模す）
  const fakeIndexJs = `
import { WEr } from './app.js';
console.log('[FIXTURE] WEr() =', WEr());
`;
  fs.writeFileSync(indexJsPath, fakeIndexJs, 'utf8');
  console.log('[Setup] Created fake index.js (ESM, imports app.js)');

  // 4. current symlink を作成
  try {
    fs.symlinkSync('1.0.65', currentLink);
    console.log('[Setup] Created symlink: current -> 1.0.65');
  } catch (e) {
    console.error('[Setup] Symlink creation failed:', e.message);
  }

  // 5. platform-patch.js から関数をロード（新API名: patchAppJsSource / isTargetCopilotAppJsUrl）
  console.log('\n[Test] Loading patchAppJsSource and isTargetCopilotAppJsUrl functions');
  const patch = require(platformPatchPath);

  assert(typeof patch.patchAppJsSource === 'function',
    'patchAppJsSource exported as function');
  assert(typeof patch.isTargetCopilotAppJsUrl === 'function',
    'isTargetCopilotAppJsUrl exported as function');

  if (typeof patch.patchAppJsSource !== 'function' || typeof patch.isTargetCopilotAppJsUrl !== 'function') {
    console.error('\n[Critical] Functions not exported. Stopping.');
    cleanup();
    process.exit(1);
  }

  // 6. isTargetCopilotAppJsUrl テスト（file:// URL ベース）
  console.log('\n[Test] isTargetCopilotAppJsUrl (file:// URL) detection');

  const actualAppUrl = pathToFileURL(fs.realpathSync(appJsPath)).href;
  assert(patch.isTargetCopilotAppJsUrl(actualAppUrl) === true,
    `isTargetCopilotAppJsUrl(actual app.js url) = true`);

  const symlinkAppUrl = pathToFileURL(path.join(currentLink, 'app.js')).href;
  assert(patch.isTargetCopilotAppJsUrl(symlinkAppUrl) === true,
    `isTargetCopilotAppJsUrl(symlink app.js url, not realpath'd) = true`);

  const indexUrl = pathToFileURL(indexJsPath).href;
  assert(patch.isTargetCopilotAppJsUrl(indexUrl) === false,
    'isTargetCopilotAppJsUrl(index.js url) = false (not app.js)');

  assert(patch.isTargetCopilotAppJsUrl('file:///some/other/place/app.js') === false,
    'isTargetCopilotAppJsUrl(no .copilot-termux segment) = false');

  assert(patch.isTargetCopilotAppJsUrl('node:module') === false,
    'isTargetCopilotAppJsUrl("node:module") = false (not file:// URL)');

  assert(patch.isTargetCopilotAppJsUrl(null) === false,
    'isTargetCopilotAppJsUrl(null) = false (null input)');

  // 7. patchAppJsSource テスト（文字列変換ロジック単体）
  console.log('\n[Test] patchAppJsSource pattern replacement (unit)');

  const originalSource = fs.readFileSync(appJsPath, 'utf8');
  const patchedSource = patch.patchAppJsSource(originalSource);

  assert(patchedSource !== originalSource,
    'patchAppJsSource returns modified content');

  assert(!patchedSource.includes('@github/copilot@'),
    'Patched content does not contain @github/copilot@ pattern');

  assert(patchedSource.includes('npm install -g @bash0816/copilot-termux'),
    'Patched content contains @bash0816/copilot-termux');

  assert(!patchedSource.includes('sendUpdateNotification('),
    'Patched content has upstream sendUpdateNotification(...) call removed (replaced with false)');

  // 7b. 【UPDATE-004/005撤去の回帰確認】changelog fallback分岐は一切パッチされず、
  //     upstream本来の形のまま残ること。フォーク独自のchangelog表示機構
  //     （globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__）が混入しないこと。
  console.log('\n[Test] UPDATE-004/005 removal regression check');

  assert(patchedSource.includes(CHANGELOG_FALLBACK_FIXTURE),
    'Patched content: upstream changelog fallback branch (if(!X.gt(u,a))return Y.execute(t,[a])) ' +
    'remains completely unmodified (UPDATE-004/005 no longer patches this)');

  assert(!patchedSource.includes('__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__'),
    'Patched content does not contain __COPILOT_TERMUX_FORK_UPDATE_MESSAGE__ ' +
    '(fork-specific changelog mechanism fully removed)');

  // 7c. UPDATE-006: DO() の releases/latest 行がフォーク npm latest fetch に置換されること
  console.log('\n[Test] UPDATE-006 fork latest pattern replacement');

  assert(!patchedSource.includes(UPDATE_006_DO_FIXTURE),
    'UPDATE-006: DO() releases/latest return line is replaced (no longer present as-is)');

  assert(patchedSource.includes('registry.npmjs.org/%40bash0816%2Fcopilot-termux/latest'),
    'UPDATE-006: patched content contains npm registry URL for fork latest');

  assert(patchedSource.includes('assets:[]'),
    'UPDATE-006: patched return value includes assets:[] for upstream compatibility');

  // ネガティブ: a$e() の行（変数 a,r）はパッチされないこと
  assert(patchedSource.includes(UPDATE_006_ASE_FIXTURE),
    'UPDATE-006 (negative): a$e() releases/latest line with vars a,r is NOT patched (remains as-is)');

  // 8. パターン検出エッジケース（複数マッチ・非マッチ時は無変更）
  console.log('\n[Test] Pattern detection edge cases');

  const multiInstallPattern = `
    const v1 = \`npm i -g @github/copilot@\${v1}\`;
    const v2 = \`npm i -g @github/copilot@\${v2}\`;
  `;
  const resultMulti = patch.patchAppJsSource(multiInstallPattern);
  assert(resultMulti === multiInstallPattern,
    'patchAppJsSource skips patch when pattern found 2+ times (no change)');

  const noPatternContent = 'const x = `npm install -g @bash0816/copilot-termux`;';
  const resultNone = patch.patchAppJsSource(noPatternContent);
  assert(resultNone === noPatternContent,
    'patchAppJsSource skips patch when pattern not found (no change)');

  // 9. パッチ後コードの実行可能性検証（ESM構文なので Function コンストラクタでは動かせない。
  //    export を除去した簡易版で実行確認する）
  console.log('\n[Test] Patched code execution validity (logic-level)');
  try {
    const executableSource = patchedSource
      .replace(/^export const /gm, 'const ')
      .replace(/^export async function /gm, 'async function ');
    const testModule = { exports: {} };
    const testFunc = new Function('module', executableSource + '\nmodule.exports = { WEr };');
    testFunc(testModule);
    assert(typeof testModule.exports.WEr === 'function',
      'Patched code can be executed and exports WEr function');

    const result = testModule.exports.WEr();
    assert(result === 'npm install -g @bash0816/copilot-termux',
      'Patched WEr() returns correct fork package install command');
  } catch (e) {
    assert(false, `Patched code execution failed: ${e.message}`);
  }

  // 10. 【最重要】registerHooks() 経由の実地検証: 子プロセスで実際に
  //     `node --require platform-patch.js <symlink経由のindex.js>` を起動し、
  //     ESM ローダーフック経由で app.js が実際にパッチされることを標準出力から確認する。
  //     これにより「関数ロジックは正しいが呼び出し機構が発火しない」という
  //     前回の見落としを再発させないようにする。
  console.log('\n[Test] End-to-end: registerHooks() actually intercepts app.js via child process');

  const symlinkIndexPath = path.join(currentLink, 'index.js');
  let e2eOutput = '';
  let e2eError = null;
  try {
    e2eOutput = execFileSync(process.execPath, ['--require', platformPatchPath, symlinkIndexPath], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env },
    });
  } catch (e) {
    // 疑似 index.js は正常終了するはずだが、万一失敗した場合も出力を確認できるようにする
    e2eOutput = (e.stdout || '') + (e.stderr || '');
    e2eError = e;
  }

  console.log('[E2E] child process output:');
  console.log(e2eOutput.split('\n').map(l => '    ' + l).join('\n'));

  assert(e2eError === null,
    'Child process (node --require platform-patch.js <symlinked index.js>) exits successfully');

  assert(e2eOutput.includes('[FIXTURE] WEr() = npm install -g @bash0816/copilot-termux'),
    'E2E: app.js loaded via ESM import through symlink was actually patched by registerHooks() ' +
    '(fixture printed the FORK install command, not the original @github/copilot one)');

  assert(!e2eOutput.includes('npm i -g @github/copilot@'),
    'E2E: original unpatched install string does not appear in child process output');

  cleanup();

} catch (e) {
  console.error('[Error]', e.message);
  console.error(e.stack);
  failCount++;
  cleanup();
}

// 結果レポート
console.log('\n' + '='.repeat(60));
console.log(`Test Results: ${passCount} PASS, ${failCount} FAIL`);
console.log('='.repeat(60));

if (failCount > 0) {
  console.error('\nFailed tests:');
  tests.filter(t => !t.passed).forEach(t => {
    console.error(`  - ${t.name}`);
  });
  process.exit(1);
} else {
  console.log('\nAll tests PASSED.');
  process.exit(0);
}
