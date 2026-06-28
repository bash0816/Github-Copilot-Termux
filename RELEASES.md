## 1.0.65 — 2026-06-28 🚀 Latest / 最新版

upstream `@github/copilot@1.0.65` 追従。Tab 補完 UI 対応・ログイン/アカウント切替修正・AI モデル選択修正。

**新機能 / New features**

- **Tab 補完 UI**: upstream 1.0.65 で追加された Tab キー補完インターフェースに対応

**バグ修正 / Bug fixes**

- **ログイン・アカウント切替 (AUTH-001)**: `authManager*` / `tokenStore*` を JS スタブで実装。
  Enterprise→Free / Free→Enterprise の切替後に認証が失敗する問題を修正。
  `authManagerSwitchToAuth` / `authManagerLoginUser` でアカウント切替時に
  `COPILOT_API_URL` を即時クリア・再フェッチするよう修正
- **Copilot API token 交換**: `/copilot_internal/v2/token` 経由の token 交換を追加。
  OAuth token を Copilot 推論 API 用 token に変換（Enterprise 環境で必須）
- **AI モデル表示 (MODEL-001)**: Free / Enterprise プランで正しいモデルのみ表示されるよう修正
  - Free プラン: `policy.state=enabled` フォールバックで `goldeneye-free-auto` を確実に選択
  - Enterprise→Free 切替後: stale なキャッシュを無効化し Free 向けモデルに上書き（TC-6 修正）
  - モデルキャッシュ世代管理 (`_modelListCacheGen`) で切替後の stale 結果を破棄
- **`agentsResolveToolAliases` JS fallback**: 新規ネイティブ関数が Bionic で不正インデックスを返す問題を修正。
  無効結果を検出し JS 実装にフォールバック（Free チャット時の 400 エラー解消）
- **`/update` コマンド**: 表示される更新コマンドを `@github/copilot` から `@bash0816/copilot-termux` に修正
- **Telemetry / AppInsights stubs**: 1.0.65 新規追加の `telemetryAppInsightsServiceState*` /
  `telemetryDelegatingSender*` / `telemetrySessionTelemetryState*` / `telemetryLegacyUsageHandler*`
  を no-op スタブで実装（Azure HTTP I/O が tokio 経由のため bionic で SIGSEGV 回避）
- **content-length 除去**: リクエスト body 書き換え後に古い `content-length` ヘッダーを除去

**動作確認 / Smoke test**

| テスト | 結果 |
|--------|------|
| TC-1: Free TUI チャット | ✅ |
| TC-2: Free `-p` モード | ✅ |
| TC-3: Enterprise TUI チャット | ✅ |
| TC-4: Enterprise `-p` モード | ✅ |
| TC-5: Enterprise→Free 切替後 `-p` | ✅ |
| TC-6: Enterprise→Free 切替後 TUI チャット | ✅ |

### Install

```sh
npm install -g @bash0816/copilot-termux@1.0.65
copilot-termux setup
copilot --version
```

---

## 1.0.63 — 2026-06-22 ✅ Current stable / 現在の安定版

upstream `@github/copilot@1.0.63` 追従。Termux bionic 互換パッチ全面適用。

**Termux 固有の修正 / Termux-specific fixes**

- **`networkFetch*` JS実装**: MCP SSE transport が `networkFetchStreamStart` を直接呼び出す際のクラッシュを修正
- **`responsesStreamDrive` 修正**: `onChunkCallback` に raw SSE イベントではなく nativeReducer パース済みの `chunkContext` を渡すよう修正（`-p` の出力が正常表示されない問題を解消）
- **`modelHttp*` JS実装**: Rust ネイティブ AI HTTP 呼び出しを Node.js fetch で代替（bionic 非対応 Rust ネットワークスタック回避）
- **`redacted_thinking` / `signature_delta` 対応**: Claude 思考モデルのストリームイベントを正しくスキップ
- **PTY モジュール**: Termux bionic ネイティブビルドの `pty.node` を同梱（TUI 対応）
- **bionic-compat.so**: glibc 依存シンボルスタブ（LD_PRELOAD）

**Smoke test 結果（Device A / このマシン）**

| テスト | 結果 |
|--------|------|
| `copilot --version` | ✅ 1.0.63 |
| `copilot -p "say hello"` | ✅ 出力・AI Credits・Token 表示 |
| MCP 接続 | ✅ |

### Install

```sh
npm install -g @bash0816/copilot-termux@1.0.63
copilot-termux setup
copilot --version
```
