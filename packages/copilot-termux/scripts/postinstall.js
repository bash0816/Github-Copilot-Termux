#!/usr/bin/env node
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const pkgDir = path.resolve(__dirname, '..');
const glibcDir = path.join(pkgDir, 'lib', 'glibc');
const prebuildDir = path.join(pkgDir, 'lib', 'copilot', 'prebuilds', 'linux-arm64');

if (!fs.existsSync(glibcDir) || !fs.existsSync(prebuildDir)) {
  process.exit(0);
}

try {
  execSync('patchelf --version', { stdio: 'ignore' });
} catch {
  console.error('[copilot-termux] patchelf not found. Please run: pkg install patchelf');
  process.exit(1);
}

for (const f of fs.readdirSync(prebuildDir).filter(f => f.endsWith('.node'))) {
  const fp = path.join(prebuildDir, f);
  try {
    execSync(`patchelf --set-rpath "${glibcDir}" "${fp}"`, { stdio: 'ignore' });
  } catch (e) {
    console.warn(`[copilot-termux] patchelf warning: ${f}: ${e.message}`);
  }
}
