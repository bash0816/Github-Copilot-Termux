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
      for (const event of st.events) {
        const eventJson = JSON.stringify(event);
        if (_nativeReducerProcessEvent) {
          try { _nativeReducerProcessEvent(reducerId, eventJson); } catch (_) {}
        }
        if (hasProcessors && typeof onChunkCallback === 'function') {
          try { onChunkCallback(eventJson); } catch (_) {}
        }
      }
      return { json: JSON.stringify({ kind: 'ok', copilotUsage: null, ttftMs: null, interTokenLatencyMs: null }) };
    };
    // --- end JS model HTTP implementation ---
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
