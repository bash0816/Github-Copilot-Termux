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

const _pkgVersion = (() => {
  try { return require(path.join(__dirname, '..', 'package.json')).version; } catch (_) { return '1.0.65'; }
})();

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
    if (result.__copilotTermuxPatched) return result;
    result.__copilotTermuxPatched = true;
    // Rust tokio を使う関数群を no-op に差し替え。
    // sessionStore*/sessionSqlite* は非同期 SQLite (tokio)、
    // modelHttp*/networkFetch*/ahpRelay*/websocketResponses* は Rust HTTP (tokio)。
    // jsonrpcServer* は拡張 JSON-RPC サーバー (ThreadsafeFunction)、
    // lspClient* は LSP クライアント (ThreadsafeFunction)。
    // featureFlagService* は同期 Rust のため除外（no-op にすると .handle クラッシュ）。
    const TOKIO_PATTERN = /^(modelHttp|networkFetch|ahpRelay|websocketResponses|sessionStore|sessionSqlite|jsonrpcServer|lspClient)/;
    for (const key of Object.keys(result)) {
      if (TOKIO_PATTERN.test(key) && typeof result[key] === 'function') {
        result[key] = () => undefined;
      }
    }
    // git*Async: Rust tokio async functions — type-safe stubs to prevent SIGSEGV.
    // Returns empty/null values matching what app.js callers expect.
    const GIT_ASYNC_STUBS = {
      gitMutateAsync:             async () => undefined,
      gitCommandAsync:            async () => '',
      gitRemotesAsync:            async () => [],
      gitDiffFileAsync:           async () => '',
      gitHashFileAsync:           async () => [],
      gitMergeBaseAsync:          async () => null,
      gitDiffForRefAsync:         async () => '',
      gitCurrentBranchAsync:      async () => null,
      gitDefaultBranchAsync:      async () => null,
      gitListWorktreesAsync:      async () => [],
      gitBranchAndHeadAsync:      async () => null,
      gitSubmodulePathsAsync:     async () => [],
      gitUntrackedPathsAsync:     async () => [],
      gitDiffNameStatusAsync:     async () => '',
      gitStatusPorcelainAsync:    async () => '',
      gitWorkingTreeStatusAsync:  async () => ({ hasUnstagedChanges: false, hasStagedChanges: false, hasUntrackedFiles: false }),
      gitStatusPorcelainAllAsync: async () => null,
      gitCurrentBranchRemoteAsync: async () => null,
      gitWorkingTreeDiffStatsAsync: async () => ({ linesAdded: 0, linesRemoved: 0 }),
    };
    for (const [key, stub] of Object.entries(GIT_ASYNC_STUBS)) {
      if (typeof result[key] === 'function') result[key] = stub;
    }
    if (typeof result.registerLogSink === 'function') {
      result.registerLogSink = () => { throw new Error('[copilot-termux] registerLogSink disabled on bionic (no tokio thread)'); };
    }
    if (typeof result.networkFetchGetExtraCaPems === 'function') {
      result.networkFetchGetExtraCaPems = () => ({ errors: [], pems: [] });
    }
    // modelsFilterToPicker: model_picker_enabled=false のモデルを全部除外してしまう。
    // GitHub Copilot API は現在全モデルに model_picker_enabled=false を返すため、
    // modelListCache が空になり m2() の fallback が null を返して "Auto-mode unavailable" になる。
    // → 全インデックスを返して全モデルを modelListCache に含める。
    if (typeof result.modelsFilterToPicker === 'function') {
      result.modelsFilterToPicker = function(modelsJson) {
        try {
          const models = JSON.parse(modelsJson);
          return Array.isArray(models) ? models.map((_, i) => i) : [];
        } catch(_) { return []; }
      };
    }
    // authGetCopilotApiUrl: type=token/env/user/gh-cli/api-key では native が null を返す。
    // _b() はこれを見て models=[] を返しモデル選択が "No supported model" になる。
    // OAuth token でも標準 copilot API URL は固定のため、null 時はデフォルト URL を返す。
    if (typeof result.authGetCopilotApiUrl === 'function') {
      const _nativeGetCopilotApiUrl = result.authGetCopilotApiUrl;
      result.authGetCopilotApiUrl = function(authInfoJson, token) {
        const r = _nativeGetCopilotApiUrl(authInfoJson, token);
        if (r != null) return r;
        try {
          const info = JSON.parse(authInfoJson);
          if (info && info.type !== 'hmac') {
            return process.env.COPILOT_API_URL || 'https://api.githubcopilot.com';
          }
        } catch (_) {}
        return r;
      };
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
        const baseUrl = process.env.COPILOT_API_URL || 'https://api.githubcopilot.com';
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
    // --- JS networkFetch* implementation (bionic: tokio networkFetch* are no-op'd) ---
    // B7 が QXe() から直接呼ばれる MCP 専用パスでクラッシュするため JS で代替。
    // networkFetchStreamStart → { requestId, response: Promise<{handle,url,status,statusText,headers}> }
    // networkFetchStreamRead   → Promise<{ done, body?: Uint8Array }>
    // networkFetchStreamClose  → void
    // networkFetchRequestCancel → void
    const _nfMap = new Map();
    let _nfIdSeq = 3e6;

    result.networkFetchStreamStart = function(req) {
      const requestId = 'nf-' + (++_nfIdSeq);
      const abortCtrl = new AbortController();
      const entry = { abort: () => abortCtrl.abort(), reader: null };
      _nfMap.set(requestId, entry);

      const headers = {};
      if (Array.isArray(req.headers)) {
        for (const { name, value } of req.headers) headers[name] = value;
      } else if (req.headers && typeof req.headers === 'object') {
        Object.assign(headers, req.headers);
      }

      const response = (async () => {
        let res;
        try {
          res = await globalThis.fetch(req.url, {
            method: req.method || 'GET',
            headers,
            body: req.body ?? undefined,
            signal: abortCtrl.signal,
            redirect: req.redirect || 'follow',
          });
        } catch (e) {
          _nfMap.delete(requestId);
          throw e;
        }
        const handle = requestId;
        const reader = res.body ? res.body.getReader() : null;
        entry.reader = reader;
        const respHeaders = [...res.headers.entries()].map(([name, value]) => ({ name, value }));
        return { handle, url: res.url, status: res.status, statusText: res.statusText, headers: respHeaders };
      })();

      return { requestId, response };
    };

    result.networkFetchStreamRead = function(handle) {
      return (async () => {
        const entry = _nfMap.get(handle);
        if (!entry || !entry.reader) return { done: true };
        try {
          const { done, value } = await entry.reader.read();
          if (done) { _nfMap.delete(handle); return { done: true }; }
          return { done: false, body: value };
        } catch (e) {
          _nfMap.delete(handle);
          throw e;
        }
      })();
    };

    result.networkFetchStreamClose = function(handle) {
      const entry = _nfMap.get(handle);
      if (entry) {
        try { entry.reader?.cancel(); } catch (_) {}
        try { entry.abort(); } catch (_) {}
        _nfMap.delete(handle);
      }
    };

    result.networkFetchRequestCancel = function(requestId) {
      const entry = _nfMap.get(requestId);
      if (entry) {
        try { entry.abort(); } catch (_) {}
        _nfMap.delete(requestId);
      }
    };

    result.networkFetchResetClients = function() {
      for (const entry of _nfMap.values()) {
        try { entry.abort(); } catch (_) {}
      }
      _nfMap.clear();
    };
    // --- end JS networkFetch* implementation ---
    // --- JS model HTTP implementation (bionic: tokio modelHttp* are no-op'd) ---
    // Stream store: streamId → {events, index, finalMessage}
    const _jsStreams = new Map();
    let _accIdSeq = 1e6;
    // Accumulator store: accId → {message}
    const _jsAccs = new Map();

    // Helper: parse Anthropic SSE body into events array
    function _parseAnthropicSSE(bodyText) {
      const events = [];
      const lines = bodyText.split(/\r\n|\r|\n/);
      let dataLines = [];
      for (const line of lines) {
        if (line === '' || line === '\r') {
          if (dataLines.length > 0) {
            const dataStr = dataLines.join('\n');
            dataLines = [];
            if (dataStr.trim() === '[DONE]') continue;
            try { events.push(JSON.parse(dataStr)); } catch(_) {}
          }
        } else if (line.startsWith('data: ')) {
          dataLines.push(line.slice(6));
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5));
        }
      }
      if (dataLines.length > 0) {
        const dataStr = dataLines.join('\n');
        if (dataStr.trim() !== '[DONE]') {
          try { events.push(JSON.parse(dataStr)); } catch(_) {}
        }
      }
      return events;
    }

    // Helper: reconstruct final Anthropic message from SSE events
    function _reconstructFinalMessage(events) {
      let message = null;
      const contentBlocks = new Map(); // index → block
      for (const e of events) {
        if (e.type === 'message_start') {
          message = {
            id: e.message && e.message.id,
            type: (e.message && e.message.type) || 'message',
            role: (e.message && e.message.role) || 'assistant',
            model: e.message && e.message.model,
            stop_reason: (e.message && e.message.stop_reason) || null,
            stop_sequence: (e.message && e.message.stop_sequence) || null,
            usage: (e.message && e.message.usage) || { input_tokens: 0, output_tokens: 0 },
            content: []
          };
        } else if (e.type === 'content_block_start') {
          const blk = e.content_block;
          if (!blk) continue;
          if (blk.type === 'text') {
            contentBlocks.set(e.index, { type: 'text', text: blk.text || '' });
          } else if (blk.type === 'tool_use') {
            contentBlocks.set(e.index, { type: 'tool_use', id: blk.id, name: blk.name, _inputBuf: '' });
          } else if (blk.type === 'thinking') {
            contentBlocks.set(e.index, { type: 'thinking', thinking: blk.thinking || '', signature: blk.signature || '' });
          } else if (blk.type === 'redacted_thinking') {
            contentBlocks.set(e.index, { type: 'redacted_thinking', data: blk.data });
          }
        } else if (e.type === 'content_block_delta') {
          const blk = contentBlocks.get(e.index);
          if (!blk || !e.delta) continue;
          if (e.delta.type === 'text_delta') {
            blk.text = (blk.text || '') + (e.delta.text || '');
          } else if (e.delta.type === 'input_json_delta') {
            blk._inputBuf = (blk._inputBuf || '') + (e.delta.partial_json || '');
          } else if (e.delta.type === 'thinking_delta') {
            blk.thinking = (blk.thinking || '') + (e.delta.thinking || '');
          } else if (e.delta.type === 'signature_delta') {
            blk.signature = (blk.signature || '') + (e.delta.signature || '');
          }
        } else if (e.type === 'content_block_stop') {
          const blk = contentBlocks.get(e.index);
          if (blk && blk.type === 'tool_use') {
            try { blk.input = JSON.parse(blk._inputBuf || '{}'); } catch(_) { blk.input = {}; }
            delete blk._inputBuf;
          }
        } else if (e.type === 'message_delta') {
          if (message) {
            if (e.delta && e.delta.stop_reason != null) message.stop_reason = e.delta.stop_reason;
            if (e.delta && e.delta.stop_sequence != null) message.stop_sequence = e.delta.stop_sequence;
            if (e.usage && e.usage.output_tokens != null && message.usage) {
              message.usage.output_tokens = e.usage.output_tokens;
            }
          }
        }
      }
      if (message) {
        const blocks = Array.from(contentBlocks.entries())
          .sort(([a], [b]) => a - b)
          .map(([, v]) => v);
        message.content = blocks;
      }
      if (!message) {
        message = { role: 'assistant', content: [], stop_reason: 'error', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
      }
      return message;
    }

    // 1. anthropicMessageStreamAccumulatorCreate → JS mock
    if (typeof result.anthropicMessageStreamAccumulatorCreate === 'function') {
      result.anthropicMessageStreamAccumulatorCreate = function(_handleJson) {
        const id = _accIdSeq++;
        _jsAccs.set(id, { message: null });
        return { json: JSON.stringify({ accumulatorId: id }) };
      };
    }

    // 2. anthropicMessageStreamAccumulatorFinish → return accumulated message
    if (typeof result.anthropicMessageStreamAccumulatorFinish === 'function') {
      result.anthropicMessageStreamAccumulatorFinish = function(id) {
        const acc = _jsAccs.get(id) || { message: null };
        _jsAccs.delete(id);
        return { json: JSON.stringify({ message: acc.message }) };
      };
    }

    // 3. anthropicMessageStreamAccumulatorDrop → cleanup
    if (typeof result.anthropicMessageStreamAccumulatorDrop === 'function') {
      result.anthropicMessageStreamAccumulatorDrop = function(id) {
        _jsAccs.delete(id);
      };
    }

    // 4. modelHttpStreamStart → fetch full SSE body, parse events
    result.modelHttpStreamStart = async function(jsonArg) {
      const req = JSON.parse(jsonArg);
      let body = req.body;
      if (body !== null && body !== undefined && typeof body === 'object') {
        if (body.type === 'Buffer' && Array.isArray(body.data)) {
          body = Buffer.from(body.data);
        } else {
          body = JSON.stringify(body);
        }
      }
      let res;
      try {
        res = await globalThis.fetch(req.url, {
          method: req.method || 'POST',
          headers: req.headers || {},
          body: body,
        });
      } catch(e) {
        throw new Error(JSON.stringify({ kind: 'network', message: e.message }));
      }
      const headers = {};
      for (const [k, v] of res.headers.entries()) headers[k] = v;
      const bodyText = await res.text().catch(() => '');
      if (res.status < 200 || res.status >= 300) {
        return { json: JSON.stringify({ bodyText, status: res.status, statusText: res.statusText, headers, streamId: null }) };
      }
      const events = _parseAnthropicSSE(bodyText);
      const finalMessage = _reconstructFinalMessage(events);
      const streamId = 'js-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      _jsStreams.set(streamId, { events, index: 0, finalMessage });
      return { json: JSON.stringify({ bodyText: null, status: res.status, statusText: res.statusText, headers, streamId }) };
    };

    // 5. modelHttpStreamNextAnthropicMessageEvent → yield events one by one
    result.modelHttpStreamNextAnthropicMessageEvent = async function(streamId, accId) {
      const st = _jsStreams.get(streamId);
      if (!st || st.index >= st.events.length) {
        if (st) {
          const acc = _jsAccs.get(accId);
          if (acc) acc.message = st.finalMessage;
          _jsStreams.delete(streamId);
        }
        return null;
      }
      return { json: JSON.stringify({ kind: 'ok', processResult: { event: st.events[st.index++] } }) };
    };

    // 6. modelHttpStreamCancel → cleanup
    result.modelHttpStreamCancel = function(streamId) {
      _jsStreams.delete(streamId);
    };

    // 7. modelHttpRequest → non-streaming fetch
    result.modelHttpRequest = async function(jsonArg) {
      const req = JSON.parse(jsonArg);
      let body = req.body;
      if (body !== null && body !== undefined && typeof body === 'object') {
        if (body.type === 'Buffer' && Array.isArray(body.data)) {
          body = Buffer.from(body.data);
        } else {
          body = JSON.stringify(body);
        }
      }
      let res;
      try {
        res = await globalThis.fetch(req.url, {
          method: req.method || 'POST',
          headers: req.headers || {},
          body: body,
        });
      } catch(e) {
        throw new Error(JSON.stringify({ kind: 'network', message: e.message }));
      }
      const headers = {};
      for (const [k, v] of res.headers.entries()) headers[k] = v;
      const bodyText = await res.text().catch(() => '');
      return { json: JSON.stringify({ bodyText, status: res.status, statusText: res.statusText, headers }) };
    };
    // 8. responsesStreamDrive → JS streamをネイティブリデューサーに流す
    // native responsesStreamDrive は Rust tokio でストリームを読む。
    // JS streamId（"js-"で始まる）はRust側にないためクラッシュ → JS実装で代替。
    const _nativeReducerProcessEvent = typeof result.openaiResponsesStreamReducerProcessEvent === 'function'
      ? result.openaiResponsesStreamReducerProcessEvent
      : null;
    result.responsesStreamDrive = async function(streamId, reducerId, hasProcessors, onChunkCallback) {
      const st = _jsStreams.get(streamId);
      if (!st) {
        throw new Error(`Native mod HTTP stream was not found: ${streamId}`);
      }
      _jsStreams.delete(streamId);
      let copilotUsage = null;
      for (const event of st.events) {
        if (!_nativeReducerProcessEvent) continue;
        let parsed;
        try { parsed = JSON.parse(_nativeReducerProcessEvent(reducerId, JSON.stringify(event)).json); }
        catch (_) { continue; }
        if (parsed && parsed.copilotUsage !== undefined && parsed.copilotUsage !== null)
          copilotUsage = parsed.copilotUsage;
        const cc = parsed && parsed.chunkContext;
        if (hasProcessors && typeof onChunkCallback === 'function' && cc &&
            (cc.content || cc.messageStart || cc.reportIntentArguments || cc.chunkBoundary || cc.size > 0)) {
          try { onChunkCallback(JSON.stringify(cc)); } catch (_) {}
        }
      }
      return { json: JSON.stringify({ kind: 'ok', copilotUsage, ttftMs: null, interTokenLatencyMs: null }) };
    };
    // === authManager* JS stubs (1.0.64: tokio thread spawn → SIGSEGV on bionic) ===
    const _authMgr = new Map(); // uuid → { cachedInfo, pendingInfo, cachedToken, cachedHost }

    result.authManagerCreate = function(uuid, hostUri, userAgent, path, normSpec, header, envVar, disableAutoLogin) {
      _authMgr.set(uuid, { cachedInfo: null, pendingInfo: null, cachedToken: null, cachedHost: null });
      // native 非呼び出し: tokio runtime 生成を阻止
    };

    async function _buildAuthInfo(token, hostUri) {
      let login = null;
      let copilotUser = null;
      try {
        const apiHost = hostUri.replace('https://github.com', 'https://api.github.com');
        const res = await globalThis.fetch(`${apiHost}/user`, {
          headers: { Authorization: `token ${token}`, 'User-Agent': `copilot-termux/${_pkgVersion}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) login = (await res.json()).login;
      } catch (_) {}
      // copilot_internal/user から copilotUser 全体を取得して authInfo に含める。
      // app.js の Wa(authInfo) は authInfo.copilotUser.endpoints.api から CAPI base URL を導く。
      // copilotUser: null のままでは is_mcp_enabled・quota・plan 情報も失われる。
      // env var は後続の capiClientListModels stub / authGetCopilotApiUrl stub でも参照するため並記する。
      try {
        const apiHost = hostUri.replace('https://github.com', 'https://api.github.com');
        const r = await globalThis.fetch(`${apiHost}/copilot_internal/user`, {
          headers: { Authorization: `token ${token}`, 'User-Agent': `copilot-termux/${_pkgVersion}`, 'Copilot-Integration-Id': 'copilot-chat' },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const info = await r.json();
          copilotUser = info;
          const apiUrl = info?.endpoints?.api;
          if (apiUrl && typeof apiUrl === 'string') process.env.COPILOT_API_URL = apiUrl;
        }
      } catch (_) {}
      return JSON.stringify({
        authInfo: { type: 'token', host: hostUri, token, login, copilotUser },
        token,
      });
    }

    async function _resolveOrCache(uuid, token, env) {
      const entry = _authMgr.get(uuid);
      if (!entry) return null;
      const hostUri = ((typeof result.githubGetUri === 'function'
        ? result.githubGetUri(
            (env && env.COPILOT_GH_HOST) || undefined,
            (env && env.GH_HOST) || undefined
          )
        : null) || 'https://github.com').replace(/\/+$/, '');
      if (entry.cachedInfo !== null && (entry.cachedToken !== token || entry.cachedHost !== hostUri)) {
        entry.cachedInfo = null;
        entry.pendingInfo = null;
      }
      if (entry.cachedInfo !== null) return entry.cachedInfo;
      if (!entry.pendingInfo) {
        entry.pendingInfo = _buildAuthInfo(token, hostUri).then(info => {
          entry.cachedInfo = info;
          entry.cachedToken = token;
          entry.cachedHost = hostUri;
          entry.pendingInfo = null;
          try {
            const parsed = JSON.parse(info);
            if (parsed && parsed.authInfo &&
                typeof parsed.authInfo.login === 'string' && parsed.authInfo.login.length > 0) {
              _loginTokens.set(`${hostUri}:${parsed.authInfo.login}`, token);
            }
          } catch (_) {}
          return info;
        }).catch(err => {
          entry.pendingInfo = null;
          throw err;
        });
      }
      return entry.pendingInfo;
    }

    result.authManagerLoadAuthInfo = async function(uuid, env, _storeTokenPlaintext) {
      const token = await _readGhToken(env);
      if (!token) return null;
      return _resolveOrCache(uuid, token, env);
    };
    result.authManagerGetCurrentAuthInfo = async function(uuid, env, _storeTokenPlaintext) {
      const entry = _authMgr.get(uuid);
      if (!entry) return null;
      if (entry.cachedInfo !== null) return entry.cachedInfo;
      if (entry.pendingInfo) return entry.pendingInfo;
      const token = await _readGhToken(env);
      if (!token) return null;
      return _resolveOrCache(uuid, token, env);
    };
    result.authManagerGetAllAuthAvailable = async function(uuid, env, _storeTokenPlaintext) {
      const token = await _readGhToken(env);
      if (!token) return [];
      const info = await _resolveOrCache(uuid, token, env);
      return info ? [info] : [];
    };
    result.authManagerGetLastAuthErrors = function(uuid) { return []; };
    result.authManagerClearCache = function(uuid) {
      const e = _authMgr.get(uuid);
      if (e) { e.cachedInfo = null; e.pendingInfo = null; e.cachedToken = null; e.cachedHost = null; }
    };
    result.authManagerSwitchToAuth = async function(uuid, authInfoJson, token) {
      const entry = _authMgr.get(uuid);
      if (entry && authInfoJson) {
        try {
          const authInfo = JSON.parse(authInfoJson);
          const hostUri = ((authInfo && authInfo.host) || 'https://github.com').replace(/\/+$/, '');
          entry.cachedInfo = JSON.stringify({ authInfo, token: token || null });
          entry.cachedToken = token || null;
          entry.cachedHost = hostUri;
          entry.pendingInfo = null;
        } catch (_) {}
      }
    };
    result.authManagerLoginUser = async function(uuid, host, login, token) {
      const entry = _authMgr.get(uuid);
      if (!entry || !token) return;
      const hostUri = (host || 'https://github.com').replace(/\/+$/, '');
      _loginTokens.set(`${hostUri}:${login || ''}`, token);
      entry.pendingInfo = _buildAuthInfo(token, hostUri).then(info => {
        entry.cachedInfo = info;
        entry.cachedToken = token;
        entry.cachedHost = hostUri;
        entry.pendingInfo = null;
        try {
          const parsed = JSON.parse(info);
          if (parsed && parsed.authInfo &&
              typeof parsed.authInfo.login === 'string' && parsed.authInfo.login.length > 0) {
            _loginTokens.set(`${hostUri}:${parsed.authInfo.login}`, token);
          }
        } catch (_) {}
        return info;
      }).catch(err => { entry.pendingInfo = null; return null; });
      await entry.pendingInfo; // ensure cachedInfo is set before app.js continues
    };
    result.authManagerLogout = async function(uuid, authInfoJson) {
      const e = _authMgr.get(uuid);
      if (e) { e.cachedInfo = null; e.pendingInfo = null; e.cachedToken = null; e.cachedHost = null; }
      return true;
    };
    result.authManagerRefreshCopilotUser = async function(uuid) {
      return null; // null → JS側 authInfoWithTokenPromise フォールバック
    };
    result.authManagerDestroy = function(uuid) { _authMgr.delete(uuid); };

    result.authResolveAuthInfoFromToken = async function(token, hostUri, skipCache, userAgent) {
      if (!token) return JSON.stringify(null);
      let login = null;
      try {
        const apiHost = (hostUri || 'https://github.com').replace('://github.com', '://api.github.com');
        const res = await globalThis.fetch(`${apiHost}/user`, {
          headers: { Authorization: `token ${token}`, 'User-Agent': userAgent || `copilot-termux/${_pkgVersion}` },
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) login = (await res.json()).login;
      } catch (_) {}
      const host = hostUri || 'https://github.com';
      return JSON.stringify({ type: 'token', host, token, login, copilotUser: null });
    };
    // === end authManager* stubs ===
    // === tokenStore* JS stubs (bionic: tokio ThreadsafeFunction crash) ===
    // Verified tokens: set by authManagerLoginUser / _resolveOrCache after /user API check
    const _loginTokens = new Map(); // "host:login" → oauthToken

    const _tokStore = new Map();
    let _tokSeq = 9e6;
    result.tokenStoreCreate = function() { const id = ++_tokSeq; _tokStore.set(id, new Map()); return id; };
    result.tokenStoreDestroy = function(h) { _tokStore.delete(h); };
    result.tokenStoreGetToken = async function(h, host, login) {
      const m = _tokStore.get(h);
      const key = `${(host || 'https://github.com').replace(/\/+$/, '')}:${login || ''}`;
      if (m) { const v = m.get(key); if (v != null) return v; }
      const lt = _loginTokens.get(key);
      if (lt != null) { if (m) m.set(key, lt); return lt; }
      if (login) return null; // login specified: refuse unverified fallback
      return _readGhToken(null);
    };
    result.tokenStoreStoreToken = function(h, token, host, login) {
      const m = _tokStore.get(h);
      if (m && token) m.set(`${(host || 'https://github.com').replace(/\/+$/, '')}:${login || ''}`, token);
    };
    result.tokenStoreRemoveToken = function(h, host, login) {
      const m = _tokStore.get(h);
      if (m) m.delete(`${(host || 'https://github.com').replace(/\/+$/, '')}:${login || ''}`);
    };
    result.tokenStoreGetAnyToken = async function(h) {
      const m = _tokStore.get(h);
      if (m && m.size > 0) return [...m.values()][0];
      return _readGhToken(null);
    };
    result.tokenStoreStoreCurrentTokenInConfig = async function() {};
    // === end tokenStore* stubs ===

    // === urlManager* JS stubs ===
    const _urlMgr = new Map();
    let _urlSeq = 8e6;
    result.urlManagerCreate = function(urls, unrestricted) {
      const id = ++_urlSeq;
      _urlMgr.set(id, { urls: Array.isArray(urls) ? [...urls] : [], unrestricted: !!unrestricted });
      return id;
    };
    result.urlManagerAddUrl = function(h, url) { const e = _urlMgr.get(h); if (e) e.urls.push(url); };
    result.urlManagerDispose = function(h) { _urlMgr.delete(h); };
    result.urlManagerGetUrls = function(h) { return (_urlMgr.get(h) || {}).urls || []; };
    result.urlManagerIsUrlAllowed = function(h, url) { return true; };
    result.urlManagerIsUnrestrictedMode = function(h) { return true; };
    result.urlManagerSetUnrestrictedMode = function(h, v) { const e = _urlMgr.get(h); if (e) e.unrestricted = v; };
    // === end urlManager* stubs ===

    // === pathManager* JS stubs ===
    const _pathMgr = new Map();
    let _pathSeq = 7e6;
    result.pathManagerCreateRestricted = async function(dirs, primary) {
      const id = ++_pathSeq;
      _pathMgr.set(id, { dirs: Array.isArray(dirs) ? [...dirs] : [], primary: primary || null });
      return id;
    };
    result.pathManagerCreateUnrestricted = async function(primary) {
      const id = ++_pathSeq;
      _pathMgr.set(id, { dirs: [], primary: primary || null });
      return id;
    };
    result.pathManagerDispose = function(h) { _pathMgr.delete(h); };
    result.pathManagerAddDirectory = function(h, dir) { const e = _pathMgr.get(h); if (e) e.dirs.push(dir); };
    result.pathManagerGetDirectories = function(h) { return (_pathMgr.get(h) || {}).dirs || []; };
    result.pathManagerGetPrimaryDirectory = function(h) { return (_pathMgr.get(h) || {}).primary || null; };
    result.pathManagerIsPathWithinWorkspace = function(h, p) {
      const e = _pathMgr.get(h);
      if (!e || !e.primary) return true;
      return p === e.primary || p.startsWith(e.primary + '/');
    };
    result.pathManagerUpdatePrimaryDirectory = function(h, dir) { const e = _pathMgr.get(h); if (e) e.primary = dir; };
    result.pathManagerIsPathWithinAllowedDirectories = function(h, p) {
      const e = _pathMgr.get(h);
      if (!e || e.dirs.length === 0) return true;
      return e.dirs.some(dir => p === dir || p.startsWith(dir + '/'));
    };
    // === end pathManager* stubs ===

    // === telemetryQueue* JS stubs ===
    let _telSeq = 6e6;
    result.telemetryQueueCreate = function(name, _config) { return ++_telSeq; };
    result.telemetryQueueDispose = function(h) {};
    result.telemetryQueueEnqueue = function(h, event) {};
    result.telemetryQueueSetDebugLogPayload = function(h, v) {};
    // === end telemetryQueue* stubs ===

    // === telemetryAppInsightsServiceState* JS stubs (1.0.65+: Azure AppInsights HTTP I/O → tokio SIGSEGV on bionic) ===
    if (typeof result.telemetryAppInsightsServiceStateCreate === 'function') {
      result.telemetryAppInsightsServiceStateCreate = function() { return ++_telSeq; };
      result.telemetryAppInsightsServiceStateDispose = function(h) {};
      result.telemetryAppInsightsServiceStateEnqueue = function(h, e, n, r) { return JSON.stringify({}); };
      result.telemetryAppInsightsServiceStateAuthSucceeded = function(h, e) { return JSON.stringify({}); };
      result.telemetryAppInsightsServiceStateLogout = function(h) { return JSON.stringify({}); };
    }
    // === end telemetryAppInsightsServiceState* stubs ===

    // === telemetryDelegatingSender* JS stubs (1.0.65+: fire-and-forget HTTP send → tokio SIGSEGV on bionic) ===
    if (typeof result.telemetryDelegatingSenderCreate === 'function') {
      result.telemetryDelegatingSenderCreate = function() { return ++_telSeq; };
      result.telemetryDelegatingSenderDispose = function(h) { return JSON.stringify({ disposeDelegate: false }); };
      result.telemetryDelegatingSenderConfigure = function(h, hasDelegate) {
        return JSON.stringify({ disposePreviousDelegate: false, disposeNewDelegate: false });
      };
      result.telemetryDelegatingSenderIsConfigured = function(h) { return false; };
      result.telemetryDelegatingSenderRequiresDelegate = function(h) {};
      result.telemetryDelegatingSenderSetInternalCorrelationIds = function(h, ids) {
        return JSON.stringify({ applyToDelegate: false });
      };
    }
    // === end telemetryDelegatingSender* stubs ===

    // === telemetrySessionTelemetryState* JS stubs (1.0.65+) ===
    if (typeof result.telemetrySessionTelemetryStateCreate === 'function') {
      result.telemetrySessionTelemetryStateCreate = function(h, e) { return ++_telSeq; };
      result.telemetrySessionTelemetryStateDispose = function(h) {};
      result.telemetrySessionTelemetryStateSnapshot = function(h) { return JSON.stringify({ telemetryEvents: [] }); };
      result.telemetrySessionTelemetryStateProcessSessionEvent = function(h, e, n) {
        return JSON.stringify({ telemetryEvents: [] });
      };
      result.telemetrySessionTelemetryStateProcessToolsUpdated = function(h, e) {};
    }
    // === end telemetrySessionTelemetryState* stubs ===

    // === telemetryLegacyUsageHandler* JS stubs (1.0.65+) ===
    if (typeof result.telemetryLegacyUsageHandlerCreate === 'function') {
      result.telemetryLegacyUsageHandlerCreate = function(h, e) { return ++_telSeq; };
      result.telemetryLegacyUsageHandlerDispose = function(h) {};
      result.telemetryLegacyUsageHandlerProcessEvent = function(h, e) { return JSON.stringify([]); };
    }
    // === end telemetryLegacyUsageHandler* stubs ===

    // === permissionService* JS stubs ===
    const _permSvc = new Map();
    let _permSeq = 5e6;
    result.permissionServiceCreate = function(config) {
      const id = ++_permSeq;
      _permSvc.set(id, { approveAll: !!(config && config.approveAllTool) });
      return id;
    };
    result.permissionServiceDispose = function(h) { _permSvc.delete(h); };
    result.permissionServiceRequest = async function(h, reqJson) {
      return JSON.stringify({ kind: 'approved' });
    };
    result.permissionServiceComplete = function(h, token, ok, resultJson) {};
    result.permissionServiceConfigure = function(h, approveAllTool, approveAllRead, approvedRules, deniedRules, pathMgr, urlMgr) {};
    result.permissionServiceAddApprovedRules = function(h, rules) {};
    result.permissionServiceGetApproveAllTool = function(h) { return (_permSvc.get(h) || {}).approveAll ?? false; };
    result.permissionServiceSetApproveAllTool = function(h, v) { const e = _permSvc.get(h); if (e) e.approveAll = v; };
    result.permissionServiceRemoveApprovedRules = function(h, rules) {};
    result.permissionServiceCheckSamplingApproval = function(h, k) { return true; };
    result.permissionServiceResetSessionApprovals = function(h) {};
    result.permissionServiceAddLocationApprovedRules = function(h, rules) {};
    result.permissionServiceRemoveLocationApprovedRules = function(h, rules) {};
    // === end permissionService* stubs ===

    // === lspManager* JS stubs ===
    let _lspMgrSeq = 4e6;
    result.lspManagerCreate = function() { return ++_lspMgrSeq; };
    result.lspManagerClear = function(h) {};
    result.lspManagerPlanForFile = function(h, file, lang, config) { return null; };
    result.lspManagerRemoveClient = function(h, key) {};
    result.lspManagerShutdownKeys = function(h) { return []; };
    result.lspManagerPlanForServerId = function(h, id) { return null; };
    result.lspManagerCachedClientCount = function(h) { return 0; };
    result.lspManagerRelevantServerIds = function(h, file, lang) { return []; };
    // === end lspManager* stubs ===

    // === ifcEngine* JS stubs ===
    const _ifc = new Map();
    let _ifcSeq = 3e6;
    result.ifcEngineCreate = function(config) { const id = ++_ifcSeq; _ifc.set(id, {}); return id; };
    result.ifcEngineDispose = function(h) { _ifc.delete(h); };
    result.ifcEngineToJson = function(h) { return '{}'; };
    result.ifcEnginePreToolHook = async function(h, tool, argsJson, fetchHandler) { return { converged: true }; };
    result.ifcEngineFetchComplete = function(h, resp) {};
    result.ifcEngineGetContextLabel = function(h) { return null; };
    result.ifcEngineSetContextLabel = function(h, label) {};
    result.ifcEnginePostToolExecution = async function(h, tool, argsJson, fetchHandler) {
      return { converged: true, applied: false, updated: false };
    };
    // === end ifcEngine* stubs ===
    // --- end JS model HTTP implementation ---
  }

  // === cli-native.node stubs (1.0.64+: color scheme fns use Rust tokio → SIGSEGV on bionic) ===
  if (typeof request === 'string' && path.basename(request) === 'cli-native.node') {
    if (!result.__copilotTermuxCliPatched) {
      result.__copilotTermuxCliPatched = true;
      // Rust tokio background thread → SIGSEGV on bionic. Return null so callers
      // fall back to "unspecified" color scheme (uses default theme).
      if (typeof result.getColorScheme === 'function') {
        result.getColorScheme = () => null;
      }
      if (typeof result.startColorSchemeListener === 'function') {
        result.startColorSchemeListener = (_cb) => undefined;
      }
      if (typeof result.stopColorSchemeListener === 'function') {
        result.stopColorSchemeListener = () => undefined;
      }
    }
  }
  // === end cli-native.node stubs ===

  return result;
};

// [Android bionic 対応] app.js の oPt() が globalThis.fetch を Rust ベースの B7 に
// 差し替えるのを阻止する。linuxmusl-arm64/runtime.node の Rust ネットワークスタックは
// bionic 上の実 I/O で動作しないため、Node.js ビルトイン fetch（動作確認済み）に固定する。
// GitHub OAuth token via env var or gh CLI (keychain unavailable on bionic)
async function _readGhToken(env) {
  const envToken =
    (env && (env.GITHUB_TOKEN || env.GH_TOKEN || env.COPILOT_GITHUB_TOKEN)) ||
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
  if (envToken) return envToken;
  try {
    const { execFile } = require('child_process');
    return await new Promise(resolve => {
      execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : (stdout.trim() || null));
      });
    });
  } catch (_) { return null; }
}

const _nativeFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get() { return _nativeFetch; },
  set(_) { /* B7 代入を無視 */ },
});
