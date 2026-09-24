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
  const { package: pkg = '@github/copilot-linux-arm64', version, integrity } = manifest.copilot;
  const versionDir = path.join(CACHE_DIR, version);
  const stagingDir = `${versionDir}.staging`;

  if (fs.existsSync(path.join(versionDir, 'copilot'))) {
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

      if (!fs.existsSync(path.join(stagingDir, 'copilot'))) {
        throw new Error(`installation incomplete: missing ${path.join(stagingDir, 'copilot')}`);
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

  fs.rmSync(wrapLibsDir, { recursive: true, force: true });
  fs.mkdirSync(wrapLibsDir, { recursive: true });

  for (const lib of ['ld-linux-aarch64.so.1', 'libc.so.6', 'libgcc_s.so.1']) {
    const src = path.join(glibcDir, lib);
    if (!fs.existsSync(src)) throw new Error(`[copilot-termux] Missing glibc lib: ${src}`);
    fs.copyFileSync(src, path.join(wrapLibsDir, lib));
  }

  const libcSo = path.join(wrapLibsDir, 'libc.so');
  try { fs.unlinkSync(libcSo); } catch (_) {}
  fs.symlinkSync('libc.so.6', libcSo);

  console.log('✓ glibc wrap ready');
}

module.exports = { setup };
