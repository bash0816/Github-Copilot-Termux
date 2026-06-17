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

// Redirect linux-arm64 native addons to linuxmusl-arm64 variants.
// bionic Node.js cannot load glibc addons; musl addons work with bionic-compat.so.
const Module = require('module');
const fs = require('fs');

const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (typeof request === 'string' && request.includes('linux-arm64') && request.endsWith('.node')) {
    const muslReq = request.replace(/linux-arm64/g, 'linuxmusl-arm64');
    try {
      const resolved = origResolve(muslReq, parent, isMain, options);
      if (fs.existsSync(resolved)) return resolved;
    } catch (_) {}
  }
  return origResolve(request, parent, isMain, options);
};
