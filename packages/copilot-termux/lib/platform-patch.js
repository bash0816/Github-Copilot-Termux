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
    if (path.basename(request) === 'pty.node' &&
        (request.includes('linux-arm64') || request.includes('linuxmusl-arm64'))) {
      if (fs.existsSync(NATIVE_PTY)) return NATIVE_PTY;
    }

    // Redirect other linux-arm64 addons to linuxmusl-arm64 variants.
    if (request.includes('linux-arm64')) {
      const muslReq = request.replace(/linux-arm64/g, 'linuxmusl-arm64');
      try {
        const resolved = origResolve(muslReq, parent, isMain, options);
        if (fs.existsSync(resolved)) return resolved;
      } catch (e) {
        if (e.code !== 'MODULE_NOT_FOUND') throw e;
      }
      // Block glibc fallback — loading linux-arm64 (glibc) on bionic causes segfault.
      throw new Error(
        `[copilot-termux] Cannot load glibc addon on bionic: ${request}\n` +
        'No linuxmusl-arm64 variant available. This addon is not supported on Android.'
      );
    }
  }
  return origResolve(request, parent, isMain, options);
};

// [Android bionic 対応] linuxmusl-arm64/runtime.node は Rust tokio を使う。
// bionic 上で musl pthread ABI でスレッドを生成すると TUI 起動時に SIGSEGV。
// runtime.node ロード後に Rust async 初期化関数を no-op に差し替えて阻止する。
const origLoad = Module._load.bind(Module);
Module._load = function (request, parent, isMain) {
  const result = origLoad(request, parent, isMain);
  if (typeof request === 'string' &&
      path.basename(request) === 'runtime.node') {
    // Rust tokio を使う関数群を no-op に差し替え。
    // sessionStore*/sessionSqlite* は非同期 SQLite (tokio)、
    // modelHttp*/networkFetch*/ahpRelay*/websocketResponses* は Rust HTTP (tokio)。
    // featureFlagService* は同期 Rust のため除外（no-op にすると .handle クラッシュ）。
    const TOKIO_PATTERN = /^(modelHttp|networkFetch|ahpRelay|websocketResponses|sessionStore|sessionSqlite)/;
    for (const key of Object.keys(result)) {
      if (TOKIO_PATTERN.test(key) && typeof result[key] === 'function') {
        result[key] = () => undefined;
      }
    }
    if (typeof result.networkFetchGetExtraCaPems === 'function') {
      result.networkFetchGetExtraCaPems = () => ({ errors: [], pems: [] });
    }
    // capiClientListModels を Node.js fetch で実装（Rust tokio SIGSEGV 回避）
    if (typeof result.capiClientListModels === 'function') {
      result.capiClientListModels = async function(handle, _includeHidden, _skipCache, _applyModelLimitCaps, _networkingConfigId) {
        let authHeaders;
        try {
          const prepared = result.capiClientPrepareRequestHeaders(handle, '', []);
          authHeaders = {};
          for (const {name, value} of prepared.headers) {
            authHeaders[name] = value;
          }
        } catch (e) {
          throw new Error(JSON.stringify({kind: 'network', message: `prepareHeaders failed: ${e.message}`}));
        }
        const baseUrl = 'https://api.githubcopilot.com';
        let res;
        try {
          res = await globalThis.fetch(`${baseUrl}/models`, {method: 'GET', headers: authHeaders});
        } catch (e) {
          throw new Error(JSON.stringify({kind: 'network', message: e.message}));
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const hdrs = [...res.headers.entries()].map(([name, value]) => ({name, value}));
          throw new Error(JSON.stringify({kind: 'http', status: res.status, statusText: res.statusText, body, headers: hdrs, hasRequestId: res.headers.has('x-request-id')}));
        }
        const data = await res.json();
        const models = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
        const rateHeaders = [...res.headers.entries()].map(([name, value]) => ({name, value}));
        return {modelsJson: JSON.stringify(models), copilotUrl: baseUrl, usageRatelimitHeaders: rateHeaders, capturedAssignmentContext: undefined};
      };
    }
    if (typeof result.sessionSqliteOpen === 'function') {
      result.sessionSqliteOpen = () => 1;
    }
    if (typeof result.sessionSqliteQuery === 'function') {
      result.sessionSqliteQuery = () => ({ rows: '[]' });
    }
    if (typeof result.sessionSqliteRun === 'function') {
      result.sessionSqliteRun = () => ({ rowsAffected: 0, lastInsertRowid: null });
    }
    if (typeof result.sessionSqliteFileExists === 'function') {
      result.sessionSqliteFileExists = () => false;
    }
  }
  return result;
};

// [Android bionic 対応] app.js の oPt() が globalThis.fetch を Rust ベースの B7 に
// 差し替えるのを阻止する。linuxmusl-arm64/runtime.node の Rust ネットワークスタックは
// bionic 上の実 I/O で動作しないため、Node.js ビルトイン fetch（動作確認済み）に固定する。
const _nativeFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get() { return _nativeFetch; },
  set(_) { /* B7 代入を無視 */ },
});
