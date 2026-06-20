'use strict';
// Override process.platform so @github/copilot treats Android as Linux.
// @github/copilot is distributed unmodified (LICENSE Section 2).
// This file is our code and is NOT part of the @github/copilot software.
Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

if (process.report) {
  const orig = process.report.getReport.bind(process.report);
  process.report.getReport = (...args) => {
    const r = orig(...args);
    if (r && r.header) r.header.platform = 'linux';
    return r;
  };
}

// Redirect linux-arm64 native addons to bionic-compatible variants.
// bionic Node.js cannot load glibc addons; glibc fallback causes segfault.
const Module = require('module');
const fs = require('fs');
const path = require('path');

// Bundled Termux-native pty.node (built against bionic, not glibc).
const NATIVE_PTY = path.join(__dirname, 'native', 'pty.node');

const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.endsWith('.node')) {
    // Redirect pty.node to our bundled Termux-native build.
    if (request.includes('pty.node') &&
        (request.includes('linux-arm64') || request.includes('linuxmusl-arm64'))) {
      if (fs.existsSync(NATIVE_PTY)) return NATIVE_PTY;
    }

    // Redirect other linux-arm64 addons to linuxmusl-arm64 variants.
    if (request.includes('linux-arm64')) {
      const muslReq = request.replace(/linux-arm64/g, 'linuxmusl-arm64');
      try {
        const resolved = origResolve(muslReq, parent, isMain, options);
        if (fs.existsSync(resolved)) return resolved;
      } catch (_) {}
      // Block glibc fallback — loading linux-arm64 (glibc) on bionic causes segfault.
      throw new Error(
        `[copilot-termux] Cannot load glibc addon on bionic: ${request}\n` +
        'No linuxmusl-arm64 variant available. This addon is not supported on Android.'
      );
    }
  }
  return origResolve(request, parent, isMain, options);
};
