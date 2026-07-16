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
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// git CLIを配列引数で呼ぶ（shell経由なし、インジェクション対策）。失敗時は例外を投げず安全な既定値を返す。
async function runGit(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (_) {
    return null;
  }
}

// backupFile() は戻り値を `${r.substring(9,25)}-${Date.now()}` としてバックアップファイル名に使う。
// substring(9,25) は "git-sha1:" (9文字) プレフィックスを除いた先頭16文字を取る計算であり、
// ネイティブ実装の実際の戻り値フォーマットが "git-sha1:<40hex>" であることを示している。
// 互換性のため git hash-object 相当（blob SHA1）を "git-sha1:" プレフィックス付きで返す。
async function hashFileContent(gitRoot, filePath) {
  try {
    const out = await runGit(gitRoot, ['hash-object', '--', filePath]);
    if (!out) return null;
    return `git-sha1:${out.trim()}`;
  } catch (_) {
    return null;
  }
}

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
      // glibc mode では bionic NDK pty.node を使わない（glibc Node との ABI 不整合）
      if (!process.env.COPILOT_TERMUX_GLIBC_MODE && fs.existsSync(NATIVE_PTY)) return NATIVE_PTY;
    }

    // Redirect other linux-arm64 addons to linuxmusl-arm64 variants.
    // In glibc mode (COPILOT_TERMUX_GLIBC_MODE=1), skip redirect — glibc addons load natively.
    if (request.includes('linux-arm64') && !process.env.COPILOT_TERMUX_GLIBC_MODE) {
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

// [glibc mode の設計方針]
// glibc mode（COPILOT_TERMUX_GLIBC_MODE=1）は「native実装に全面的に任せるモード」ではない。
// 正しくは「glibc addon のロードを可能にしつつ、Copilot-Termux が検証済みの
// JS通信/認証/モデル解決の経路は両モード共通で維持するモード」である。
// 常時適用されるJSスタブ（isGlibcMode分岐がない箇所）は、bionic回避だけでなく
// Copilot token交換・Free/Enterprise endpoint補正・モデルstale対策・
// tools payload補正・stream互換維持を兼ねているため、glibc modeでも意図的に残す。
// native実装に戻す変更は、スタブ単位ではなくauth/network/model/streamの連鎖単位で
// 実機検証してから行う（2026-07-06 GPT-5.5レビュー結論）。

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
    let _nfIdSeq = 3e6;
    const isGlibcMode = !!process.env.COPILOT_TERMUX_GLIBC_MODE;
    if (!isGlibcMode) {
      // Rust tokio を使う関数群を no-op に差し替え。
      // sessionStore*/sessionSqlite* は非同期 SQLite (tokio)、
      // modelHttp*/networkFetch*/ahpRelay*/websocketResponses* は Rust HTTP (tokio)。
      // jsonrpcServer* は拡張 JSON-RPC サーバー (ThreadsafeFunction)、
      // lspClient* は LSP クライアント (ThreadsafeFunction)。
      // featureFlagService* は同期 Rust のため除外（no-op にすると .handle クラッシュ）。
      const TOKIO_PATTERN = /^(ahpRelay|ahpRelayAuthenticate|ahpRelayCancelTurn|ahpRelayCompleteInput|ahpRelayCompletions|ahpRelayConfirmToolCall|ahpRelayConnect|ahpRelayCreate|ahpRelayCreateSession|ahpRelayDispose|ahpRelayGetPlan|ahpRelayListCheckpoints|ahpRelayListWorkspaceFiles|ahpRelayPendingRequiredResourcesJson|ahpRelayReadCheckpoint|ahpRelayRefreshSessions|ahpRelayReleaseSession|ahpRelayRemovePendingMessage|ahpRelaySelectAgent|ahpRelaySessionDiff|ahpRelaySetMode|ahpRelaySetModel|ahpRelaySetPendingMessage|ahpRelaySetSessionApproveAll|ahpRelaySetTitle|ahpRelayStartTurn|ahpRelayStateJson|ahpRelaySubscribeSession|ahpRelayTerminalDispose|ahpRelayTerminalEnsure|ahpRelayTerminalWrite|jsonrpcServer|jsonrpcServerAddConnection|jsonrpcServerBeginShutdown|jsonrpcServerConnectionClose|jsonrpcServerConnectionNotify|jsonrpcServerConnectionNotifyAfterResponse|jsonrpcServerConnectionRequest|jsonrpcServerConnectionWrite|jsonrpcServerCreate|jsonrpcServerDispatchComplete|jsonrpcServerRegisterHookCallback|jsonrpcServerRegisterSession|jsonrpcServerRemove|jsonrpcServerRemoveSession|jsonrpcServerStartTcpListener|jsonrpcServerStopTcpListener|jsonrpcServerUnregisterHookCallback|jsonrpcServerUnregisterSessionHookCallback|lspClient|lspClientCloseDocument|lspClientCreateOwned|lspClientCreateOwnedSandboxed|lspClientDispose|lspClientEnhanceStartupErrorMessage|lspClientFindSourceFile|lspClientInitialize|lspClientInitialized|lspClientOpenDocument|lspClientOwnedShutdown|lspClientRequest|lspClientTakeExitInfo|lspClientWaitForDiagnostics|lspClientWaitForProjectLoad|modelHttp|modelHttpCancelRequest|modelHttpRegisterCancellation|modelHttpResetNetworking|networkFetch|networkFetchNextRequestId|networkFetchResetClients|sessionSqlite|sessionSqliteClose|sessionSqliteExec|sessionStore|sessionStoreBeginForgeSkillProposalGeneration|sessionStoreClose|sessionStoreCompleteForgeSkillProposalGeneration|sessionStoreDefaultPath|sessionStoreDeleteDynamicContextItem|sessionStoreEnsureSession|sessionStoreExec|sessionStoreExecuteReadOnly|sessionStoreExecuteReadOnlyAsync|sessionStoreExecuteReadOnlyWithCap|sessionStoreFailStaleGeneratingForgeSkillProposals|sessionStoreGetCheckpoints|sessionStoreGetDynamicContextBoard|sessionStoreGetDynamicContextItem|sessionStoreGetFiles|sessionStoreGetForgeSkillProposalByFingerprint|sessionStoreGetForgeSkillProposalById|sessionStoreGetForgeSkillProposalWorkspaceBefore|sessionStoreGetForgeTrajectoryEvents|sessionStoreGetForgeTrajectoryEventsForScope|sessionStoreGetMaxTurnIndex|sessionStoreGetRefs|sessionStoreGetSession|sessionStoreGetStats|sessionStoreGetTurns|sessionStoreIncrementDynamicContextCount|sessionStoreIncrementDynamicContextReadCount|sessionStoreIndexWorkspaceArtifact|sessionStoreInsertAssistantUsageEventWithRuntimeDefaults|sessionStoreInsertCheckpointWithRuntimeDefaults|sessionStoreInsertDynamicContextItem|sessionStoreInsertFileWithRuntimeDefaults|sessionStoreInsertForgeTrajectoryEventWithRuntimeDefaults|sessionStoreInsertRefWithRuntimeDefaults|sessionStoreInsertTurnWithRuntimeDefaults|sessionStoreListForgeSkillProposals|sessionStoreOpen|sessionStoreSearch|sessionStoreTrackingEventOperations|sessionStoreTrackingExtractFilePath|sessionStoreTrackingExtractForgeTrajectoryEvents|sessionStoreTrackingExtractRefsFromBash|sessionStoreTrackingExtractRefsFromMcpTool|sessionStoreTrackingExtractRepoFromMcpTool|sessionStoreTrackingFlushOperations|sessionStoreTrackingInitialState|sessionStoreTransitionForgeSkillProposalStatus|sessionStoreUpsertDynamicContextItem|sessionStoreUpsertSessionWithRuntimeDefaults|websocketResponses|websocketResponsesPersistent)/;
      for (const key of Object.keys(result)) {
        if (TOKIO_PATTERN.test(key) && typeof result[key] === 'function') {
          result[key] = () => undefined;
        }
      }
      // networkFetchNextRequestId は networkFetchStreamStart/RequestCancel の相関キーとして
      // 実際に使われるため、no-opのままにはできない。TOKIO_PATTERNの一括no-op化で
      // 潰された直後にJSの単調増加ID生成で上書きする。
      result.networkFetchNextRequestId = () => 'nf-' + (++_nfIdSeq);
      // MCP-BIONIC-001: 実機でSIGSEGV確認済みの2関数を、bionicモード限定でクリーンエラー化する。
      // 対象外の残り10関数はdocs/KNOWN-BUGS.mdのMCP-BIONIC-001セクションに未検証事項として個別記録済み。
      const BIONIC_SIGSEGV_STUBS = [
        'capiClientRetrieveAvailableModels',
        'mcpClientConnectStreamableHttpWithHandlersAndOnclose',
      ];
      for (const _key of BIONIC_SIGSEGV_STUBS) {
        if (typeof result[_key] === 'function') {
          result[_key] = () => {
            throw new Error(`${_key} unsupported on Android bionic (native tokio disabled to avoid SIGSEGV)`);
          };
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
        gitFindRootWithOptionalWorktreeResolutionAsync: async (cwd) => {
          const out = await runGit(cwd || process.cwd(), ['rev-parse', '--show-toplevel']);
          const root = out ? out.trim() : null;
          return root ? { found: true, gitRoot: root } : { found: false };
        },
        gitCommitShaAsync: async (gitRoot) => {
          const out = await runGit(gitRoot, ['rev-parse', 'HEAD']);
          return out ? out.trim() : null;
        },
        gitStatusFilesAsync: async (gitRoot) => {
          // --untracked-files=all: 未追跡ディレクトリを "?? dir/" に畳まず、配下ファイルを個別に列挙させる。
          // SnapshotManager.backupFile はディレクトリを保存できないため、ディレクトリ単位の畳み込みだと
          // 未追跡ディレクトリ配下のファイルが rollback 対象から漏れる。
          const out = await runGit(gitRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
          if (!out) return [];
          const entries = out.split('\0').filter(Boolean);
          const results = [];
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const status = entry.slice(0, 2);
            const relPath = entry.slice(3);
            // rename/copy: X or Y can be 'R'/'C' (index or worktree side); -z format is "to\0from\0"
            const isRenameOrCopy = status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
            if (isRenameOrCopy && entries[i + 1] !== undefined) {
              i++; // skip the old path field
            }
            // 削除(D)されたファイルは lstat/hash 対象が存在しないため除外する。
            if (status[0] === 'D' || status[1] === 'D') continue;
            results.push({ path: path.join(gitRoot, relPath), status });
          }
          return results;
        },
        gitHashFilesPrefixedAsync: async (gitRoot, files) => {
          const list = Array.isArray(files) ? files : [];
          const out = [];
          for (const p of list) {
            const hash = await hashFileContent(gitRoot, p);
            if (hash) out.push({ path: p, hash });
          }
          return out;
        },
        gitHashSingleFileAsync: async (gitRoot, filePath) => {
          const hash = await hashFileContent(gitRoot, filePath);
          return hash || '';
        },
        gitUntrackedPathsWithOptionalDirectoryAsync: async (gitRoot, opts) => {
          const args = ['ls-files', '--others', '--exclude-standard'];
          if (opts && opts.directory) args.push('--directory');
          const out = await runGit(gitRoot, args);
          if (!out) return [];
          return out.split('\n').filter(Boolean);
        },
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
    // agentsResolveToolAliases: v1.0.65 新規追加ネイティブ関数。
    // Free ユーザーのチャット時に呼ばれ、Bionic で誤ったインデックスを返すと
    // tools[N].function.name が undefined → Copilot API 400 になる。
    // ネイティブ結果を検証し、無効なら JS 実装でフォールバックする。
    if (typeof result.agentsResolveToolAliases === 'function') {
      const _nativeResolveAliases = result.agentsResolveToolAliases;
      result.agentsResolveToolAliases = function(allowedTools, allToolsMeta, externalToolsMeta) {
        try {
          const r = _nativeResolveAliases(allowedTools, allToolsMeta, externalToolsMeta);
          if (Array.isArray(r) && r.length > 0 &&
              r.every(i => typeof i === 'number' && i >= 0 && i < allToolsMeta.length)) {
            return r;
          }
        } catch(e) {
        }
        // JS フォールバック
        const allowed = allowedTools;
        // null または ["*"] → 全ツール
        if (!allowed || (allowed.length === 1 && allowed[0] === '*')) {
          return allToolsMeta.map((_, i) => i);
        }
        // 空配列 → 空配列（許可ツールなし）
        if (allowed.length === 0) {
          return [];
        }
        // 名前マッチング
        const allowedSet = new Set(allowed.map(n => (n || '').toLowerCase()));
        const indices = [];
        allToolsMeta.forEach((tool, i) => {
          const name = (tool.name || '').toLowerCase();
          const ns = (tool.namespacedName || '').toLowerCase();
          if (allowedSet.has(name) || allowedSet.has(ns)) indices.push(i);
        });
        return indices;
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
            return 'https://api.githubcopilot.com';
          }
        } catch (_) {}
        return r;
      };
    }
    // capiClientPrepareRequestHeaders: native は OAuth token をそのまま Bearer にする。
    // Copilot 推論 API は Copilot token が必要なため、キャッシュ済み copilotToken で差し替え。
    if (typeof result.capiClientPrepareRequestHeaders === 'function') {
      const _nativePrepareRequestHeaders = result.capiClientPrepareRequestHeaders;
      result.capiClientPrepareRequestHeaders = function(handle, ...args) {
        const prepared = _nativePrepareRequestHeaders(handle, ...args);
        // _authMgr から有効な copilotToken を探して Authorization を差し替え
        const now = Date.now();
        for (const entry of _authMgr.values()) {
          if (entry.copilotToken && (entry.copilotTokenExpiry === 0 || entry.copilotTokenExpiry > now)) {
            if (prepared && Array.isArray(prepared.headers)) {
              const headers = prepared.headers.map(h =>
                h.name && h.name.toLowerCase() === 'authorization'
                  ? { name: h.name, value: `Bearer ${entry.copilotToken}` }
                  : h
              );
              return { ...prepared, headers };
            }
          }
        }
        return prepared;
      };
    }
    // modelsFilterToPicker: native は model_picker_enabled=true のモデルのみ返す。
    // Free プランは全モデル model_picker_enabled=false → native が [] を返す。
    // PICKER-001: fallback に gpt-4o-mini/gpt-4o を返すと TUI /model ピッカーに
    // ユーティリティモデルが表示されてしまう（公式仕様違反）。
    // auto モードの default 選択は modelResolverFirstAvailableDefaultFromOrder が担うため
    // ここでは fallback せず [] を返す。
    if (typeof result.modelsFilterToPicker === 'function') {
      const _nativeModelsFilterToPicker = result.modelsFilterToPicker;
      result.modelsFilterToPicker = function(...args) {
        const nativeResult = _nativeModelsFilterToPicker.apply(this, args);
        if (Array.isArray(nativeResult) && nativeResult.length > 0) return nativeResult;
        return [];
      };
    }
    // capiClientListModels を Node.js fetch で実装（Rust tokio SIGSEGV 回避）
    // _selectCapiUrl: COPILOT_API_URL が api.individual.githubcopilot.com（Free プラン専用 direct endpoint）の
    // 場合のみそれを使う。Enterprise proxy URL（api.business.githubcopilot.com 等）では /models が 421 に
    // なるため標準 CAPI に倒す。hostname 完全一致チェックで SSRF/token 漏洩を防ぐ（GPT-5.5 指摘 #1）。
    const _DEFAULT_CAPI_URL = 'https://api.githubcopilot.com';
    const _INDIVIDUAL_CAPI_URL = 'https://api.individual.githubcopilot.com';
    function _selectCapiUrl(rawApiUrl) {
      try {
        const u = new URL(rawApiUrl || _DEFAULT_CAPI_URL);
        if (u.protocol === 'https:' && u.hostname === 'api.individual.githubcopilot.com') {
          return _INDIVIDUAL_CAPI_URL;
        }
      } catch (e) {
      }
      return _DEFAULT_CAPI_URL;
    }
    if (typeof result.capiClientListModels === 'function') {
      result.capiClientListModels = async function(handle, _includeHidden, _skipCache, _applyModelLimitCaps, _networkingConfigId) {
        const snapshotGen = _modelListCacheGen; // 開始時の世代をキャプチャ → 完了時に照合して stale 結果を破棄
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
        // fetchUrl: /models 取得URL。Free は api.individual（COPILOT_API_URL 設定時）、他は標準 CAPI。
        // copilotUrl: 推論URL。常に標準 CAPI 固定（v1.0.63 と同じ）。
        // BUG-NEW-2 で copilotUrl=fetchUrl にしたため api.individual への推論が発生していた（副作用修正）。
        const fetchUrl = _selectCapiUrl(process.env.COPILOT_API_URL);
        const copilotUrl = _DEFAULT_CAPI_URL;
        let res;
        try {
          res = await globalThis.fetch(`${fetchUrl}/models`, {method: 'GET', headers: authHeaders});
        } catch (e) {
          throw new Error(JSON.stringify({kind: 'network', message: e.message}));
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const hdrs = [...res.headers.entries()].map(([name, value]) => ({name, value}));
          throw new Error(JSON.stringify({kind: 'http', status: res.status, statusText: res.statusText, body, headers: hdrs, hasRequestId: res.headers.has('x-request-id')}));
        }
        const data = await res.json();
        const raw = Array.isArray(data) ? data : (data.data ?? data.models ?? []);
        const models = Array.isArray(raw) ? raw : [];
        if (_modelListCacheGen === snapshotGen) {
          _modelListCache = models;
        } else {
        }
        const rateHeaders = [...res.headers.entries()].map(([name, value]) => ({name, value}));
        return {modelsJson: JSON.stringify(models), copilotUrl, usageRatelimitHeaders: rateHeaders, capturedAssignmentContext: undefined};
      };
    }
    // --- JS networkFetch* implementation (bionic: tokio networkFetch* are no-op'd) ---
    // B7 が QXe() から直接呼ばれる MCP 専用パスでクラッシュするため JS で代替。
    // networkFetchStreamStart(requestId, req) → Promise<{handle,url,status,statusText,headers}>
    //   （2026-07-12修正: 実際のCLI本体は requestId を第1引数、req を第2引数として渡し、
    //     戻り値を直接thenableとして扱う。旧実装は1引数・{requestId,response}のラップ返却で
    //     この規約と不一致だったため s.then is not a function / Failed to parse URL from undefined
    //     エラーの原因になっていた。詳細は docs/KNOWN-BUGS.md AGENT-001参照）
    // networkFetchStreamRead   → Promise<{ done, body?: Uint8Array }>
    // networkFetchStreamClose  → void
    // networkFetchRequestCancel → void
    const _nfMap = new Map();

    result.networkFetchStreamStart = function(requestId, req) {
      const abortCtrl = new AbortController();
      const entry = { abort: () => abortCtrl.abort(), reader: null };
      _nfMap.set(requestId, entry);

      // Fix (TOOLS-002): tools[].function.name が空/undefined のエントリをフィルタリング
      let body = req.body ?? undefined;
      if (body) {
        try {
          const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
          if (parsed && Array.isArray(parsed.tools)) {
            const before = parsed.tools.length;
            parsed.tools = parsed.tools.filter(
              t => t && t.function && typeof t.function.name === 'string' && t.function.name.length > 0
            );
            if (parsed.tools.length !== before) {
              if (parsed.tools.length === 0) delete parsed.tools;
              body = JSON.stringify(parsed);
            }
          }
        } catch(_) {}
      }

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
            body: body,
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

      return response;
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
      // Fix 2 (MODEL-001): /responses 以外は reasoning_effort を除去（/v1/messages 等が 400 になるのを防ぐ）
      if (body && req.url && !req.url.includes('/responses')) {
        try {
          const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
          if (parsed && 'reasoning_effort' in parsed) {
            delete parsed.reasoning_effort;
            body = JSON.stringify(parsed);
          }
        } catch(_) {}
      }
      // Fix (TOOLS-002): tools[].function.name が空/undefined のエントリをフィルタリング
      if (body) {
        try {
          const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
          if (parsed && Array.isArray(parsed.tools)) {
            const before = parsed.tools.length;
            parsed.tools = parsed.tools.filter(
              t => t && t.function && typeof t.function.name === 'string' && t.function.name.length > 0
            );
            if (parsed.tools.length !== before) {
              if (parsed.tools.length === 0) delete parsed.tools;
              body = JSON.stringify(parsed);
            }
          }
        } catch(_) {}
      }
      // Fix (TC-6): Free account model override — Enterprise→Free 切替後に stale モデルが残る問題
      body = _applyModelOverride(body, req.url, 'modelHttpStreamStart');
      // body 書き換え後に content-length が古くなるのを防ぐ（reasoning_effort/tools/model 除去で長さが変わる）
      const fetchHeaders = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        if (k.toLowerCase() !== 'content-length') fetchHeaders[k] = v;
      }
      let res;
      try {
        res = await globalThis.fetch(req.url, {
          method: req.method || 'POST',
          headers: fetchHeaders,
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
    // Helper: convert Anthropic SSE event → chunkContext for processAnthropicStreamingChunkContext
    function _toChunkContext(event, streamId) {
      const base = { content: '', size: 0, chunkBoundary: false, messageStart: false, streamingId: streamId };
      if (!event || !event.type) return base;
      switch (event.type) {
        case 'message_start':
          return { ...base, messageStart: true };
        case 'content_block_delta': {
          const d = event.delta;
          if (!d) return base;
          if (d.type === 'text_delta') {
            const t = d.text || '';
            return { ...base, content: t, size: Buffer.byteLength(t, 'utf8') };
          }
          if (d.type === 'thinking_delta') {
            const r = d.thinking || '';
            return { ...base, reasoningContent: r, size: Buffer.byteLength(r, 'utf8') };
          }
          return base;
        }
        case 'content_block_stop':
        case 'message_delta':
        case 'message_stop':
          return { ...base, chunkBoundary: true };
        default:
          return base;
      }
    }
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
      const event = st.events[st.index++];
      const chunkContext = _toChunkContext(event, streamId);
      const tokenEvent = event.type === 'content_block_delta' && !!(event.delta && event.delta.type === 'text_delta');
      return { json: JSON.stringify({ kind: 'ok', processResult: { event, chunkContext, tokenEvent, copilotUsage: null } }) };
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
      // Fix 2 (MODEL-001): /responses 以外は reasoning_effort を除去
      if (body && req.url && !req.url.includes('/responses')) {
        try {
          const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
          if (parsed && 'reasoning_effort' in parsed) {
            delete parsed.reasoning_effort;
            body = JSON.stringify(parsed);
          }
        } catch(_) {}
      }
      // Fix (TOOLS-002): tools[].function.name が空/undefined のエントリをフィルタリング
      if (body) {
        try {
          const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
          if (parsed && Array.isArray(parsed.tools)) {
            const before = parsed.tools.length;
            parsed.tools = parsed.tools.filter(
              t => t && t.function && typeof t.function.name === 'string' && t.function.name.length > 0
            );
            if (parsed.tools.length !== before) {
              if (parsed.tools.length === 0) delete parsed.tools;
              body = JSON.stringify(parsed);
            }
          }
        } catch(_) {}
      }
      // Fix (TC-6): Free account model override — Enterprise→Free 切替後に stale モデルが残る問題
      body = _applyModelOverride(body, req.url, 'modelHttpRequest');
      // body 書き換え後に content-length が古くなるのを防ぐ
      const fetchHeaders = {};
      for (const [k, v] of Object.entries(req.headers || {})) {
        if (k.toLowerCase() !== 'content-length') fetchHeaders[k] = v;
      }
      let res;
      try {
        res = await globalThis.fetch(req.url, {
          method: req.method || 'POST',
          headers: fetchHeaders,
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
    // Helper: Free アカウント切替後に Enterprise モデルが残る問題を防ぐ model override。
    // /chat/completions 系 URL にのみ適用し、_modelListCache の enabled モデルと照合。
    // 対象外の場合は body をそのまま返す（破壊なし）。
    function _applyModelOverride(body, url, prefix) {
      try {
        if (!body) return body;
        const pathname = new URL(url).pathname;
        // /chat/completions のみを対象にする
        if (!pathname.endsWith('/chat/completions')) return body;
        const parsed = JSON.parse(typeof body === 'string' ? body : body.toString());
        if (!parsed || !parsed.model) return body;
        if (_modelListCache && _modelListCache.length > 0) {
          const enabledIds = new Set(
            _modelListCache.filter(m => m?.policy?.state === 'enabled').map(m => m.id).filter(Boolean)
          );
          if (!enabledIds.has(parsed.model)) {
            // goldeneye-free-auto のみを対象にする
            const OVERRIDE_CANDIDATES = ['goldeneye-free-auto'];
            let fallbackModel = null;
            for (const id of OVERRIDE_CANDIDATES) {
              const m = _modelListCache.find(m => m?.id === id && m?.policy?.state === 'enabled');
              if (m) { fallbackModel = id; break; }
            }
            if (fallbackModel) {
              parsed.model = fallbackModel;
              return JSON.stringify(parsed);
            }
          }
        }
      } catch(_) {}
      return body;
    }

    // 9. chatCompletionStreamDrive → OpenAI-compatible chat completion stream処理
    // native は JS-side streamId（"js-"）を知らないため JS で代替。
    result.chatCompletionStreamDrive = async function(streamId, reducerId, hasProcessors, onChunkCallback) {
      const st = _jsStreams.get(streamId);
      if (!st) {
        throw new Error(`Native model HTTP stream was not found: ${streamId}`);
      }
      _jsStreams.delete(streamId);
      let content = '', finishReason = null, id = null, model = null, role = 'assistant', usage = null, created = null;
      const toolCallsByIndex = new Map(); // index → {id, type, function: {name, arguments}}
      let functionCall = null; // 旧 delta.function_call 形式
      let isFirstChunk = true;
      // Fix (GPT-5.5 No-Go #1): 終端 finish_reason が来たか追跡する
      // finishReason || 'stop' のデフォルトは壊れたストリームを正常完了に見せる危険がある
      let seenTerminalFinishReason = false;
      const TERMINAL_FINISH_REASONS = new Set(['stop', 'tool_calls', 'function_call', 'length', 'content_filter']);
      for (const event of st.events) {
        if (!event) continue;
        if (event.id) id = event.id;
        if (event.model) model = event.model;
        if (event.usage) usage = event.usage;
        if (event.created) created = event.created;
        if (!Array.isArray(event.choices)) continue;
        for (const choice of event.choices) {
          if (choice.delta) {
            if (choice.delta.role) role = choice.delta.role;
            if (typeof choice.delta.content === 'string') content += choice.delta.content;
            // tool_calls 断片を index ごとに集約
            if (Array.isArray(choice.delta.tool_calls)) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsByIndex.has(idx)) {
                  toolCallsByIndex.set(idx, { id: '', type: 'function', function: { name: '', arguments: '' } });
                }
                const entry = toolCallsByIndex.get(idx);
                if (tc.id) entry.id = tc.id;
                if (tc.type) entry.type = tc.type;
                if (tc.function) {
                  if (tc.function.name) entry.function.name += tc.function.name;
                  if (typeof tc.function.arguments === 'string') entry.function.arguments += tc.function.arguments;
                }
              }
            }
            // 旧 function_call 形式
            if (choice.delta.function_call) {
              if (!functionCall) functionCall = { name: '', arguments: '' };
              if (choice.delta.function_call.name) functionCall.name += choice.delta.function_call.name;
              if (typeof choice.delta.function_call.arguments === 'string') functionCall.arguments += choice.delta.function_call.arguments;
            }
          }
          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            if (TERMINAL_FINISH_REASONS.has(choice.finish_reason)) seenTerminalFinishReason = true;
          }
        }
        if (hasProcessors && typeof onChunkCallback === 'function') {
          let chunkContent = '', isBoundary = false, hasToolDelta = false;
          for (const choice of event.choices) {
            if (choice.delta && typeof choice.delta.content === 'string') chunkContent += choice.delta.content;
            // Fix (GPT-5.5 No-Go #2): tool/function call delta も callback に通知する
            if (choice.delta && (choice.delta.tool_calls || choice.delta.function_call)) hasToolDelta = true;
            if (choice.finish_reason) isBoundary = true;
          }
          if (chunkContent || isBoundary || isFirstChunk || hasToolDelta) {
            try { onChunkCallback(JSON.stringify({ content: chunkContent, size: Buffer.byteLength(chunkContent, 'utf8'), chunkBoundary: isBoundary, messageStart: isFirstChunk, streamingId: streamId })); } catch (_) {}
          }
          isFirstChunk = false;
        }
      }
      const toolCalls = toolCallsByIndex.size > 0
        ? Array.from(toolCallsByIndex.entries()).sort(([a], [b]) => a - b).map(([, v]) => v)
        : undefined;
      // tool call 系では content は null が正しい（テキストと排他）
      const msgContent = (toolCalls || functionCall) ? (content || null) : content;
      const message = { role, content: msgContent };
      if (toolCalls) message.tool_calls = toolCalls;
      if (functionCall) message.function_call = functionCall;
      // Fix (GPT-5.5 No-Go #1): 終端が来ていない場合は 'stop' を補完しない
      const effectiveFinishReason = seenTerminalFinishReason ? finishReason : (finishReason ?? null);
      const completion = {
        id: id || ('chatcmpl-' + Date.now().toString(36)),
        object: 'chat.completion',
        created: created || Math.floor(Date.now() / 1000),
        model: model || 'gpt-4o',
        choices: [{ index: 0, message, finish_reason: effectiveFinishReason, logprobs: null }],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return { json: JSON.stringify({ kind: 'ok', completion, copilotUsage: null, ttftMs: null, interTokenLatencyMs: null }) };
    };
    // glibc modeでも維持（isGlibcMode分岐なし）: bionic回避に加えCopilot token交換・アカウント切替キャッシュ管理を兼ねるため
    // === authManager* JS stubs (1.0.64: tokio thread spawn → SIGSEGV on bionic) ===
    const _authMgr = new Map(); // uuid → { cachedInfo, pendingInfo, cachedToken, cachedHost, gen }
    let _modelListCache = null; // capiClientListModels が取得したモデルリストキャッシュ（modelResolver fallback 用）
    let _modelListCacheGen = 0; // アカウント切替時にインクリメント → 古い /models 結果の上書きを防ぐ

    result.authManagerCreate = function(uuid, hostUri, userAgent, path, normSpec, header, envVar, disableAutoLogin) {
      _authMgr.set(uuid, { cachedInfo: null, pendingInfo: null, cachedToken: null, cachedHost: null, gen: 0, copilotToken: null, copilotTokenExpiry: 0 });
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
      } catch (e) {
      }
      // copilot_internal/user から copilotUser 全体を取得して authInfo に含める。
      // app.js の Wa(authInfo) は authInfo.copilotUser.endpoints.api から CAPI base URL を導く。
      // copilotUser: null のままでは is_mcp_enabled・quota・plan 情報も失われる。
      // env var は後続の capiClientListModels stub / authGetCopilotApiUrl stub でも参照するため並記する。
      try {
        const apiHost = hostUri.replace('https://github.com', 'https://api.github.com');
        const r = await globalThis.fetch(`${apiHost}/copilot_internal/user`, {
          headers: { Authorization: `token ${token}`, 'User-Agent': `copilot-termux/${_pkgVersion}`, 'Copilot-Integration-Id': process.env.GITHUB_COPILOT_INTEGRATION_ID || 'copilot-developer-cli' },
          signal: AbortSignal.timeout(5000),
        });
        if (r.ok) {
          const info = await r.json();
          copilotUser = info;
          const apiUrl = info?.endpoints?.api;
          if (apiUrl && typeof apiUrl === 'string') process.env.COPILOT_API_URL = apiUrl;
        } else {
        }
      } catch (e) {
      }
      // Copilot API token 取得（推論 API は OAuth token を受け付けないため交換が必要）
      let copilotToken = null;
      let copilotTokenExpiry = 0;
      try {
        const apiHost = hostUri.replace('https://github.com', 'https://api.github.com');
        const t = await globalThis.fetch(`${apiHost}/copilot_internal/v2/token`, {
          method: 'GET',
          headers: { Authorization: `token ${token}`, 'User-Agent': `copilot-termux/${_pkgVersion}`, 'Copilot-Integration-Id': process.env.GITHUB_COPILOT_INTEGRATION_ID || 'copilot-developer-cli' },
          signal: AbortSignal.timeout(5000),
        });
        if (t.ok) {
          const td = await t.json();
          copilotToken = td.token || null;
          copilotTokenExpiry = copilotToken ? _normalizeCopilotTokenExpiry(td.expires_at) : 0;
        } else {
          let body = null;
          try { const raw = await t.text(); body = raw.length > 500 ? raw.slice(0, 500) + '…' : raw; } catch (_) {}
        }
      } catch (e) {
      }
      return JSON.stringify({
        authInfo: { type: 'token', host: hostUri, token, login, copilotUser },
        token,
        copilotToken,
        copilotTokenExpiry,
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
        entry.copilotToken = null;
        entry.copilotTokenExpiry = 0;
        _modelListCache = null;
        _modelListCacheGen++;
        delete process.env.COPILOT_API_URL;
      }
      if (entry.cachedInfo !== null) {
        return entry.cachedInfo;
      }
      if (!entry.pendingInfo) {
        const gen = entry.gen;
        entry.pendingInfo = _buildAuthInfo(token, hostUri).then(info => {
          if (entry.gen !== gen) return info; // stale: a newer switch superseded this fetch
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
            // authManagerSwitchToAuth / authManagerLoginUser と同様に copilotToken を設定
            // _resolveOrCache 経由（TUI 初回起動）でも copilot token が使われるようにする
            entry.copilotToken = (parsed && parsed.copilotToken) || null;
            entry.copilotTokenExpiry = (parsed && parsed.copilotTokenExpiry) || 0;
          } catch (_) {}
          return info;
        }).catch(err => {
          if (entry.gen === gen) entry.pendingInfo = null;
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
      if (e) { e.gen++; e.cachedInfo = null; e.pendingInfo = null; e.cachedToken = null; e.cachedHost = null; e.copilotToken = null; e.copilotTokenExpiry = 0; _modelListCache = null; _modelListCacheGen++; delete process.env.COPILOT_API_URL; }
    };
    result.authManagerSwitchToAuth = async function(uuid, authInfoJson, token) {
      const entry = _authMgr.get(uuid);
      if (!entry) return;
      // Clear stale enterprise endpoint and auth cache regardless of token presence
      delete process.env.COPILOT_API_URL;
      _modelListCache = null;
      _modelListCacheGen++;
      const gen = ++entry.gen;
      entry.cachedInfo = null;
      entry.cachedToken = null;
      entry.cachedHost = null;
      entry.pendingInfo = null;
      entry.copilotToken = null;
      entry.copilotTokenExpiry = 0;
      if (!token) return;
      const hostUri = (() => {
        try { return (JSON.parse(authInfoJson)?.host || 'https://github.com').replace(/\/+$/, ''); }
        catch (_) { return 'https://github.com'; }
      })();
      entry.pendingInfo = _buildAuthInfo(token, hostUri).then(info => {
        if (entry.gen !== gen) return info; // stale: a newer switch superseded this fetch
        entry.cachedInfo = info;
        entry.cachedToken = token;
        entry.cachedHost = hostUri;
        entry.pendingInfo = null;
        try { const p = JSON.parse(info); entry.copilotToken = p.copilotToken || null; entry.copilotTokenExpiry = p.copilotTokenExpiry || 0; } catch(_) {}
        return info;
      }).catch(err => {
        if (entry.gen === gen) entry.pendingInfo = null;
      });
      await entry.pendingInfo;
    };
    result.authManagerLoginUser = async function(uuid, host, login, token) {
      const entry = _authMgr.get(uuid);
      if (!entry || !token) return;
      const hostUri = (host || 'https://github.com').replace(/\/+$/, '');
      _loginTokens.set(`${hostUri}:${login || ''}`, token);
      delete process.env.COPILOT_API_URL;
      _modelListCache = null;
      _modelListCacheGen++;
      const gen = ++entry.gen;
      entry.pendingInfo = _buildAuthInfo(token, hostUri).then(info => {
        if (entry.gen !== gen) return info; // stale: a newer switch superseded this fetch
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
        try { const p = JSON.parse(info); entry.copilotToken = p.copilotToken || null; entry.copilotTokenExpiry = p.copilotTokenExpiry || 0; } catch(_) {}
        return info;
      }).catch(err => { if (entry.gen === gen) entry.pendingInfo = null; return null; });
      await entry.pendingInfo; // ensure cachedInfo is set before app.js continues
    };
    result.authManagerLogout = async function(uuid, authInfoJson) {
      const e = _authMgr.get(uuid);
      if (e) { e.cachedInfo = null; e.pendingInfo = null; e.cachedToken = null; e.cachedHost = null; e.copilotToken = null; e.copilotTokenExpiry = 0; _modelListCache = null; _modelListCacheGen++; delete process.env.COPILOT_API_URL; }
      return true;
    };
    result.authManagerRefreshCopilotUser = async function(uuid) {
      return null; // null → JS側 authInfoWithTokenPromise フォールバック
    };
    result.authManagerDestroy = function(uuid) { _authMgr.delete(uuid); };

    if (!isGlibcMode && typeof result.authResolveAuthInfoFromToken === 'function') {
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
    }
    // glibc mode では native authResolveAuthInfoFromToken を使う（SSL_CERT_FILE で TLS 修正済み）
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

    if (!isGlibcMode) {
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
    }
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

// glibc modeでも維持（isGlibcMode分岐なし、かつファイルスコープのためそもそも分岐不可）:
// JS実装のnetworkFetch*/modelHttp*/capiClientListModelsがglobalThis.fetchに依存しているため、
// ここだけglibc modeでnative fetchに戻すと、JSスタブがRust fetch経由になり前提が崩れる。

const _COPILOT_TOKEN_DEFAULT_TTL_MS = 28 * 60 * 1000;
function _normalizeCopilotTokenExpiry(expiresAt, now = Date.now()) {
  const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(parsed) && parsed > now ? parsed : now + _COPILOT_TOKEN_DEFAULT_TTL_MS;
}

async function _readGhToken(env) {
  const envToken =
    (env && (env.GITHUB_TOKEN || env.GH_TOKEN || env.COPILOT_GITHUB_TOKEN)) ||
    process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN;
  if (envToken) {
    return envToken;
  }
  try {
    const { execFile } = require('child_process');
    const ghToken = await new Promise(resolve => {
      execFile('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : (stdout.trim() || null));
      });
    });
    return ghToken;
  } catch (_) {
    return null;
  }
}

const _nativeFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get() { return _nativeFetch; },
  set(_) { /* B7 代入を無視 */ },
});

// UPDATE-001 / UPDATE-003: 公式 GitHub Copilot CLI (@github/copilot) の app.js に対するパッチ。
// (1) `/update` が表示するインストールコマンド文字列を fork のパッケージ名に差し替える (UPDATE-001)
// (2) upstream 公式リポジトリ (github/copilot-cli) のリリースチェックに基づく起動時通知バナーを無効化する (UPDATE-003)
// app.js は ~/.copilot-termux/<version>/package.json の "type":"module" により ESM としてロードされる。
// CJS専用の Module._extensions['.js'] はESMコンパイルに一切関与しないため機能しない
// （2026-07-02 実機再現で確認済み）。正しい介入点は node:module の registerHooks()
// (Node v22.15.0/v23.5.0+ で追加された同期 ESM Loader Hook)。未対応のNodeではフィーチャー検出で
// スキップし、パッチなしでフォールバックする。
const { fileURLToPath } = require('url');

function isTargetCopilotAppJsUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return false;
  let filename;
  try {
    filename = fileURLToPath(url);
  } catch (_) {
    return false;
  }
  // app.js が `.copilot-termux/<version-or-current>/app.js` に直接あることを要求する
  // （codex STEP8 指摘: basename + セグメント包含だけだと
  // `.copilot-termux/<version>/node_modules/**/app.js` のような無関係な深い階層にも
  // 誤反応しうるため、`.copilot-termux` の直後2セグメント目である場合のみ許可する）
  if (path.basename(filename) !== 'app.js') return false;
  const segments = filename.split(/[\\/]/);
  const idx = segments.indexOf('.copilot-termux');
  if (idx === -1) return false;
  return idx + 2 === segments.length - 1;
}

function patchAppJsSource(source) {
  let patched = source;

  const INSTALL_CMD_PATTERN = /`npm i -g @github\/copilot@\$\{[^}]+\}`/g;
  const installMatches = patched.match(INSTALL_CMD_PATTERN);
  if (installMatches && installMatches.length === 1) {
    patched = patched.replace(INSTALL_CMD_PATTERN, '`npm install -g @bash0816/copilot-termux`');
  } else {
    console.warn('[copilot-termux] UPDATE-001: update string pattern ' +
      (installMatches ? 'found ' + installMatches.length + ' times' : 'not found') + ', skipping patch');
  }

  const NOTIFY_PATTERN = /[a-zA-Z0-9_$]+\.gt\([a-zA-Z0-9_$]+\.tag_name,[a-zA-Z0-9_$]+\(\)\)&&\([a-zA-Z0-9_$]+\.info\(`Update available: \$\{[a-zA-Z0-9_$]+\.tag_name\}`\),[a-zA-Z0-9_$]+\.sendUpdateNotification\(`\$\{[a-zA-Z0-9_$]+\.tag_name\} available \\xB7 run \/update`\)\)/g;
  const notifyMatches = patched.match(NOTIFY_PATTERN);
  if (notifyMatches && notifyMatches.length === 1) {
    patched = patched.replace(NOTIFY_PATTERN, 'false');
  } else {
    console.warn('[copilot-termux] UPDATE-003: upstream release notification pattern ' +
      (notifyMatches ? 'found ' + notifyMatches.length + ' times' : 'not found') + ', skipping patch');
  }

  // UPDATE-006: DO() 内の releases/latest 取得先をフォーク自身の npm dist-tag latest に差し替える。
  // 変数名 o,n はDO()固有（a$e()は a,r を使うため誤爆しない）。
  // changelog本文の取得（nj.execute / fetchReleaseByTag、owner:"github"）は一切変更しない。
  const FORK_LATEST_PATTERN = /return\(await rF\(o=>gR\("GET \/repos\/\{owner\}\/\{repo\}\/releases\/latest",\{owner:"github",repo:"copilot-cli",headers:o\}\),n\)\)\.data/g;
  const forkLatestMatches = patched.match(FORK_LATEST_PATTERN);
  if (forkLatestMatches && forkLatestMatches.length === 1) {
    patched = patched.replace(FORK_LATEST_PATTERN,
      'return await(async()=>{try{' +
      'const res=await fetch("https://registry.npmjs.org/%40bash0816%2Fcopilot-termux/latest",{signal:AbortSignal.timeout(5000)});' +
      'if(!res.ok)throw new Error("npm registry returned "+res.status);' +
      'const data=await res.json();' +
      'if(!data||typeof data.version!=="string")throw new Error("npm registry response missing version");' +
      'const ver=data.version.replace(/-\\d+$/,"");' +
      'if(!/^\\d+\\.\\d+\\.\\d+$/.test(ver))throw new Error("invalid version: "+data.version);' +
      'return{tag_name:"v"+ver,assets:[]};' +
      '}catch(e){return{error:String(e)};}})()'
    );
  } else {
    console.warn('[copilot-termux] UPDATE-006: fork latest pattern ' +
      (forkLatestMatches ? 'found ' + forkLatestMatches.length + ' times' : 'not found') + ', skipping patch');
  }

  // UPDATE-006b: 「更新なし」の場合のchangelog表示をcurrent(a)からfork-latest(u)に変更する。
  // upstreamは「更新なし → nj.execute(t,[a])」（aは現在バージョン）だが、
  // フォーク自身のnpm latestを判定元にした結果、currentがfork-latestより新しい場合でも
  // aのchangelogが出続ける問題を解消する。
  // nj.execute内部（fetchReleaseByTag / owner:"github" / changelog.json）は変更しない。
  const NO_UPDATE_PATTERN = /if\(!ELt\.default\.gt\(u,a\)\)return nj\.execute\(t,\[a\]\)/g;
  const noUpdateMatches = patched.match(NO_UPDATE_PATTERN);
  if (noUpdateMatches && noUpdateMatches.length === 1) {
    patched = patched.replace(NO_UPDATE_PATTERN,
      'if(!ELt.default.gt(u,a))return nj.execute(t,[u.replace(/^v/,"")])'
    );
  } else {
    console.warn('[copilot-termux] UPDATE-006b: no-update changelog pattern ' +
      (noUpdateMatches ? 'found ' + noUpdateMatches.length + ' times' : 'not found') + ', skipping patch');
  }

  return patched;
}

if (!globalThis.__COPILOT_TERMUX_ESM_PATCH_REGISTERED__) {
  globalThis.__COPILOT_TERMUX_ESM_PATCH_REGISTERED__ = true;
  const { registerHooks } = require('module');
  if (typeof registerHooks === 'function') {
    registerHooks({
      load(url, context, nextLoad) {
        const result = nextLoad(url, context);
        if (!isTargetCopilotAppJsUrl(url)) return result;
        if (result.source == null) return result;
        const wasNonString = typeof result.source !== 'string';
        const src = wasNonString ? Buffer.from(result.source).toString('utf8') : result.source;
        const patched = patchAppJsSource(src);
        return Object.assign({}, result, { source: patched });
      }
    });
  } else {
    console.warn('[copilot-termux] UPDATE-001/003: node:module registerHooks() not available on this Node version (' + process.version + '), skipping app.js patch');
  }
}

module.exports.patchAppJsSource = patchAppJsSource;
module.exports.isTargetCopilotAppJsUrl = isTargetCopilotAppJsUrl;
