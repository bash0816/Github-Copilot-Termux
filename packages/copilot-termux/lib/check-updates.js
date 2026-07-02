'use strict';
const cp = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const packageDir = path.resolve(__dirname, '..');
const pkg = require(path.join(packageDir, 'package.json'));
const currentVersion = pkg.version;
const packageName = pkg.name; // @bash0816/copilot-termux

// prefix は __dirname から動的に取得。
// __dirname = <prefix>/lib/node_modules/@bash0816/copilot-termux/lib
// prefix   = <prefix>
// つまり 5 段上
const npmPrefix = path.resolve(__dirname, '../../../../..');

const cacheRoot = path.join(os.homedir(), '.copilot-termux');
const cacheFile = path.join(cacheRoot, 'update-check.json');
const ttlMs = 24 * 60 * 60 * 1000;

// --- semver 軽量実装（依存なし） ---
// バージョン文字列を [major, minor, patch, pre] に分解して比較
function parseVer(v) {
  // 例: "1.0.65-1" -> { nums: [1,0,65], pre: "1" }
  //     "1.0.65"   -> { nums: [1,0,65], pre: null }
  const [base, ...preParts] = v.split('-');
  const nums = base.split('.').map(Number);
  const pre = preParts.length > 0 ? preParts.join('-') : null;
  return { nums, pre };
}

// このプロジェクトの prerelease 表記は x.y.z-N（N は数字のみ）を前提としており、
// 汎用 semver のような英数混在 prerelease 識別子の比較は想定していません。
// returns negative if a < b, 0 if equal, positive if a > b
function compareVersions(a, b) {
  const pa = parseVer(a);
  const pb = parseVer(b);
  for (let i = 0; i < 3; i++) {
    const na = pa.nums[i] || 0;
    const nb = pb.nums[i] || 0;
    if (na !== nb) return na - nb;
  }
  // prerelease: no pre = stable > has pre (semver spec)
  if (pa.pre === null && pb.pre !== null) return 1;
  if (pa.pre !== null && pb.pre === null) return -1;
  if (pa.pre !== null && pb.pre !== null) {
    const aParts = pa.pre.split('.');
    const bParts = pb.pre.split('.');
    const len = Math.max(aParts.length, bParts.length);
    for (let j = 0; j < len; j++) {
      const ap = aParts[j], bp = bParts[j];
      if (ap === undefined) return -1;
      if (bp === undefined) return 1;
      const an = Number(ap), bn = Number(bp);
      if (!isNaN(an) && !isNaN(bn)) {
        if (an !== bn) return an - bn;
      } else {
        if (ap < bp) return -1;
        if (ap > bp) return 1;
      }
    }
    return 0;
  }
  return 0;
}

function isPrerelease(v) {
  return v.includes('-');
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}

function writeCache(data) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2) + '\n');
}

function fetchVersionManifest(tag) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(tag)}`;
    const req = https.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function fetchVersion(tag) {
  return fetchVersionManifest(tag).then(m => m.version);
}

const RELEASE_OWNER = 'bash0816';
const RELEASE_REPO = 'Github-Copilot-Termux';
const RELEASE_NOTES_MAX_BYTES = 65536; // 64KB上限。超過時はabortしてreject（SSRF対策ではなく素朴なDoS/メモリ対策）

// GitHub Releases API から該当バージョンのリリースノートを取得する。
// UPDATE-005: npm registryのカスタムフィールド方式は publish 済みバージョンに
// 後付けできないため、GitHub Releases（owner/repoはハードコード、SSRF対策として
// 外部入力やpackage.json.repositoryから動的に取らない）に切り替えた。
function fetchReleaseNotes(version) {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tags/v${encodeURIComponent(version)}`;
    const req = https.get(url, {
      timeout: 5000,
      headers: {
        'User-Agent': packageName,
        Accept: 'application/vnd.github+json',
      },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      let size = 0;
      let aborted = false;
      res.on('data', c => {
        size += c.length;
        if (size > RELEASE_NOTES_MAX_BYTES) {
          aborted = true;
          req.destroy(new Error('response too large'));
          return;
        }
        body += c;
      });
      res.on('end', () => {
        if (aborted) return;
        try {
          const json = JSON.parse(body);
          resolve({
            name: typeof json.name === 'string' ? json.name : null,
            body: typeof json.body === 'string' ? json.body : '',
            htmlUrl: typeof json.html_url === 'string' ? json.html_url : null,
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function resolveTarget() {
  const latestVer = await fetchVersion('latest');

  let bestVer = latestVer;

  // current が prerelease または current > latest の場合のみ candidate も確認
  if (isPrerelease(currentVersion) || compareVersions(currentVersion, latestVer) > 0) {
    try {
      const candidateVer = await fetchVersion('candidate');
      // latest と candidate のうちより新しい方を bestVer とする
      if (compareVersions(candidateVer, bestVer) > 0) {
        bestVer = candidateVer;
      }
    } catch {
      // candidate タグ取得失敗は無視
    }
  }

  if (compareVersions(bestVer, currentVersion) <= 0) return null;
  return bestVer;
}

function installVersion(targetVer) {
  const spec = `${packageName}@${targetVer}`;
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) {
    console.log(`npm install -g --prefix ${npmPrefix} ${spec}`);
    return 0;
  }
  console.error(`Updating to ${targetVer}...`);
  const result = cp.spawnSync('npm', ['install', '-g', '--prefix', npmPrefix, spec], {
    stdio: 'inherit',
    env: { ...process.env, DISABLE_INSTALLATION_CHECKS: 'true' },
  });
  if (result.status !== 0) {
    console.error(`\nUpdate failed. Run manually:\n  DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix ${npmPrefix} ${spec}`);
  }
  return result.status === null ? 1 : result.status;
}

async function runUpdate() {
  let targetVer;
  try {
    targetVer = await resolveTarget();
  } catch (e) {
    console.error(`Failed to check for updates: ${e.message}`);
    console.error(`Run manually: DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix ${npmPrefix} ${packageName}@latest`);
    return 1;
  }
  if (!targetVer) {
    console.error(`Already on latest version: ${currentVersion}`);
    return 0;
  }
  return installVersion(targetVer);
}

async function runNotify() {
  const cache = readCache();
  const now = Date.now();
  // TTL キャッシュ: 24h 以内に確認済みならスキップ
  if (cache.notifyCheckedAt && now - cache.notifyCheckedAt < ttlMs) return 0;

  let targetVer;
  try {
    targetVer = await resolveTarget();
    writeCache({ ...cache, notifyCheckedAt: now });
  } catch {
    return 0; // 失敗は無視（stderr を汚さない）
  }
  if (!targetVer) return 0;
  console.error(`Update available: ${currentVersion} → ${targetVer}`);
  console.error('Run: copilot update');
  return 0;
}

module.exports = { runUpdate, runNotify, resolveTarget, currentVersion, fetchVersionManifest, fetchReleaseNotes };

// CLI entry
if (require.main === module) {
  const mode = process.argv[2] || 'notify';
  const fn = mode === 'update' ? runUpdate : runNotify;
  fn().then(code => { process.exitCode = code; }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
