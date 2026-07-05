'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const manifest = require('../config/manifest.json');

const REGISTRY = 'https://registry.npmjs.org';
const CACHE_DIR = path.join(os.homedir(), '.copilot-termux');

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: headers || {},
    };
    https.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        resolve(httpsGet(res.headers.location, headers));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function fetchWithIntegrity(url, expectedIntegrity) {
  const buf = await httpsGet(url);
  const [algo, expected] = expectedIntegrity.split('-');
  const actual = crypto.createHash(algo).update(buf).digest('base64');
  const expectedBuf = Buffer.from(expected, 'base64');
  const actualBuf = Buffer.from(actual, 'base64');
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error(`integrity check failed: expected ${expectedIntegrity}, got ${algo}-${actual}`);
  }
  return buf;
}

async function setup() {
  const { package: pkg = '@github/copilot-linuxmusl-arm64', version, integrity } = manifest.copilot;
  const versionDir = path.join(CACHE_DIR, version);
  const stagingDir = `${versionDir}.staging`;

  if (fs.existsSync(path.join(versionDir, 'index.js'))) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log(`${pkg}@${version} already installed, refreshing symlink...`);
  } else {
    console.log(`Fetching ${pkg}@${version} metadata...`);
    const metaBuf = await httpsGet(`${REGISTRY}/${pkg}/${version}`, { Accept: 'application/json' });
    const meta = JSON.parse(metaBuf.toString());
    const tarballUrl = meta.dist.tarball;

    console.log(`Downloading ${pkg}@${version}...`);
    const tarball = await fetchWithIntegrity(tarballUrl, integrity);

    const tarballPath = path.join(CACHE_DIR, `copilot-${version}.tgz`);
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.writeFileSync(tarballPath, tarball);

      console.log('Extracting...');
      fs.mkdirSync(stagingDir, { recursive: true });
      execFileSync('tar', ['-xzf', tarballPath, '-C', stagingDir, '--strip-components=1']);

      if (!fs.existsSync(path.join(stagingDir, 'index.js'))) {
        throw new Error(`installation incomplete: missing ${path.join(stagingDir, 'index.js')}`);
      }

      if (fs.existsSync(versionDir)) {
        fs.rmSync(versionDir, { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, versionDir);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    } finally {
      fs.rmSync(tarballPath, { force: true });
    }
  }

  await setupGlibcWrap();
  await setupGlibcRuntime(versionDir, version);
  await setupGlibcNode();

  const currentLink = path.join(CACHE_DIR, 'current');
  const tmp = path.join(CACHE_DIR, `current.tmp.${process.pid}`);
  try { fs.unlinkSync(tmp); } catch (_) {}
  fs.symlinkSync(versionDir, tmp);
  fs.renameSync(tmp, currentLink);

  console.log(`✓ copilot ${version} ready`);
}

async function setupGlibcWrap() {
  const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const glibcDir = path.join(PREFIX, 'glibc', 'lib');
  const LD = path.join(glibcDir, 'ld-linux-aarch64.so.1');
  if (!fs.existsSync(LD)) {
    throw new Error(`[copilot-termux] glibc not found at ${glibcDir}. Please install glibc-repo: pkg install glibc-repo && pkg install glibc`);
  }

  const wrapLibsDir = path.join(CACHE_DIR, 'glibc-wrap-libs');
  const mxcWrapDir = path.join(CACHE_DIR, 'mxc-wrap', 'arm64');

  fs.rmSync(wrapLibsDir, { recursive: true, force: true });
  fs.mkdirSync(wrapLibsDir, { recursive: true });
  fs.mkdirSync(mxcWrapDir, { recursive: true });

  for (const lib of ['ld-linux-aarch64.so.1', 'libc.so.6', 'libgcc_s.so.1']) {
    const src = path.join(glibcDir, lib);
    if (!fs.existsSync(src)) throw new Error(`[copilot-termux] Missing glibc lib: ${src}`);
    fs.copyFileSync(src, path.join(wrapLibsDir, lib));
  }

  const libcSo = path.join(wrapLibsDir, 'libc.so');
  try { fs.unlinkSync(libcSo); } catch (_) {}
  fs.symlinkSync('libc.so.6', libcSo);

  const wrapperPath = path.join(mxcWrapDir, 'lxc-exec');
  const wrapperContent = [
    '#!/bin/sh',
    '_CACHE="${HOME}/.copilot-termux"',
    '_LIBS="${_CACHE}/glibc-wrap-libs"',
    '_LD="${_LIBS}/ld-linux-aarch64.so.1"',
    '_LXC="${_CACHE}/current/mxc-bin/arm64/lxc-exec"',
    'exec env -u LD_PRELOAD "$_LD" --library-path "$_LIBS" "$_LXC" "$@"',
  ].join('\n') + '\n';
  fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });

  console.log('✓ glibc wrap for lxc-exec ready');
}

async function setupGlibcRuntime(versionDir, version) {
  const linux64Dir = path.join(versionDir, 'prebuilds', 'linux-arm64');
  const runtimeNode = path.join(linux64Dir, 'runtime.node');
  const cliNativeNode = path.join(linux64Dir, 'cli-native.node');
  if (fs.existsSync(runtimeNode) && fs.existsSync(cliNativeNode)) {
    return;
  }

  const glibcPkg = '@github/copilot-linux-arm64';
  console.log(`Fetching ${glibcPkg}@${version} metadata...`);
  const metaBuf = await httpsGet(`${REGISTRY}/${glibcPkg}/${version}`, { Accept: 'application/json' });
  const meta = JSON.parse(metaBuf.toString());
  const tarballUrl = meta.dist.tarball;
  const integrity = meta.dist.integrity;

  console.log(`Downloading ${glibcPkg}@${version} (glibc runtime)...`);
  const tarball = await fetchWithIntegrity(tarballUrl, integrity);

  const tarballPath = path.join(CACHE_DIR, `copilot-glibc-${version}.tgz`);
  try {
    fs.writeFileSync(tarballPath, tarball);
    fs.mkdirSync(linux64Dir, { recursive: true });

    console.log('Extracting glibc runtime.node...');
    execFileSync('tar', [
      '-xzf', tarballPath,
      '-C', path.join(versionDir, 'prebuilds'),
      '--strip-components=2',
      'package/prebuilds/linux-arm64/runtime.node',
      'package/prebuilds/linux-arm64/cli-native.node',
    ]);
  } finally {
    fs.rmSync(tarballPath, { force: true });
  }
  console.log('✓ glibc runtime.node ready');
}

async function setupGlibcNode() {
  const { version, sha256: expectedSha256 } = manifest.glibcNode;
  const nodeVersionDir = path.join(CACHE_DIR, `glibc-node-${version}`);
  const nodeBin = path.join(nodeVersionDir, 'node');
  const currentLink = path.join(CACHE_DIR, 'glibc-node');

  const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
  const glibcLd = path.join(PREFIX, 'glibc', 'lib', 'ld-linux-aarch64.so.1');
  const glibcLibs = path.join(PREFIX, 'glibc', 'lib');

  // glibc動的リンカ経由でないとTermux(bionic)上ではglibc Nodeバイナリを実行できないため、
  // ld-linux 経由で `node -v` を実行しバージョン文字列を確認する。
  function verifyNodeBinary(binPath) {
    const out = execFileSync(glibcLd, ['--library-path', glibcLibs, binPath, '-v'], { encoding: 'utf8' }).trim();
    return out === `v${version}`;
  }

  let needsDownload = true;
  if (fs.existsSync(nodeBin)) {
    try {
      if (verifyNodeBinary(nodeBin)) {
        needsDownload = false;
      } else {
        console.log(`glibc node at ${nodeVersionDir} failed version check, re-downloading...`);
        fs.rmSync(nodeVersionDir, { recursive: true, force: true });
      }
    } catch (e) {
      // 破損バイナリ・実行不可などpartial stateからの自己修復
      console.log(`glibc node at ${nodeVersionDir} failed to execute (${e.message}), re-downloading...`);
      fs.rmSync(nodeVersionDir, { recursive: true, force: true });
    }
  }

  if (needsDownload) {
    const tarballUrl = `https://nodejs.org/dist/v${version}/node-v${version}-linux-arm64.tar.gz`;
    console.log(`Downloading Node.js v${version} (glibc)...`);
    const tarball = await httpsGet(tarballUrl);

    const actualSha256 = crypto.createHash('sha256').update(tarball).digest('hex');
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Node.js integrity check failed: expected ${expectedSha256}, got ${actualSha256}`);
    }

    const stagingDir = `${nodeVersionDir}.staging.${process.pid}`;
    const tarballPath = path.join(CACHE_DIR, `node-glibc-${version}.tgz`);
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.writeFileSync(tarballPath, tarball);
      fs.mkdirSync(stagingDir, { recursive: true });

      console.log('Extracting node binary...');
      execFileSync('tar', [
        '-xzf', tarballPath,
        '-C', stagingDir,
        '--strip-components=2',
        `node-v${version}-linux-arm64/bin/node`,
      ]);
      const stagingBin = path.join(stagingDir, 'node');
      fs.chmodSync(stagingBin, 0o755);

      // staging側で実行検証（glibcローダー経由）。失敗すれば例外がそのまま
      // 呼び出し元に伝播し、stagingはcatchで削除、nodeVersionDirには一切触れない。
      if (!verifyNodeBinary(stagingBin)) {
        throw new Error(`Downloaded glibc node binary failed version check (expected v${version})`);
      }

      // 既存の nodeVersionDir が壊れた状態で残っている場合に備え、rename前にクリア
      // （ここまで到達した時点で staging 側の検証は完了済みなので安全）
      fs.rmSync(nodeVersionDir, { recursive: true, force: true });
      fs.renameSync(stagingDir, nodeVersionDir);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    } finally {
      fs.rmSync(tarballPath, { force: true });
    }
  }

  // Migration: 1.0.68以前の glibc-node は実ディレクトリだった。
  // 新バージョンの用意（既存流用 or 新規ダウンロード、どちらもverifyNodeBinary通過済み）が
  // 完全に成功した後（ここまで到達した時点）でのみ、旧実ディレクトリを削除する。
  let currentLinkStat = null;
  try { currentLinkStat = fs.lstatSync(currentLink); } catch (_) {}
  if (currentLinkStat && currentLinkStat.isDirectory() && !currentLinkStat.isSymbolicLink()) {
    fs.rmSync(currentLink, { recursive: true, force: true });
  }

  const tmpLink = path.join(CACHE_DIR, `glibc-node.tmp.${process.pid}`);
  try { fs.unlinkSync(tmpLink); } catch (_) {}
  fs.symlinkSync(nodeVersionDir, tmpLink);
  fs.renameSync(tmpLink, currentLink);

  console.log('✓ glibc node ready');
}

module.exports = { setup };
