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
