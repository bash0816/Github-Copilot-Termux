## 1.0.68 — 2026-07-04 🚀 Latest / 最新版

upstream `@github/copilot@1.0.68` 追従。

**修正内容**

- **`/update` 実行時の changelog 表示を upstream 本来の挙動に修正**（UPDATE-004・UPDATE-005撤去）: フォーク独自の GitHub Release ノート取得機能を削除し、upstream 本来の `/changelog` コマンド実行を復活
- **Watch自動化の復旧**: `napi-audit.js` の ENOBUFS エラーを修正し、`Copilot version watch` ワークフローを復旧
- **`config/manifest.json` が実体（upstream バージョン）に追従しない問題を修正**（MANIFEST-002）

**既知の問題**

- **TUI `/update` の changelog 表示**: `/update` 実行時に表示される changelog が現在インストール済みのバージョンではなく、upstream の最新バージョンのものが表示される場合があります

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.65-1 — 2026-07-03 🔒 Previous stable / 旧安定版

upstream `@github/copilot@1.0.65` 追従（wrapper バージョンは `1.0.65-1`）。1.0.65 の既知問題を修正。

**修正内容**

- **TUI login regression**: glibc mode で TUI ログインが失敗する問題を修正（`isGlibcMode` 分岐の見直し、CA証明書パス修正、SQLite handle エラー修正、pty.node ABI 修正）
- **`/update` 実行時の参照先修正**（UPDATE-001）: インストールコマンドが upstream 公式パッケージ（`@github/copilot`）を指していたのを `@bash0816/copilot-termux`（fork）を指すよう修正
- **起動時通知バナーの誤表示修正**（UPDATE-003）: upstream 公式リポジトリの新バージョンを fork ユーザーに通知してしまう問題を修正（バナー自体を無効化）
- **`copilot update` / `copilot-termux update` の自己更新対応**（UPDATE-002）: それまで npm パッケージ自体を更新できなかった問題を修正。ダウングレード防止・rollback誤案内の修正込み

**既知の問題（解消済み）**

- `/update` 実行時の changelog 表示問題（UPDATE-004・UPDATE-005）→ 1.0.68 で撤去・修正済み
- `/update` の latest 判定元問題（UPDATE-006）→ 1.0.68 で修正済み

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.65 — 2026-06-28 ⚠️ Superseded by 1.0.65-1 / 1.0.65-1 に置き換え済み

upstream `@github/copilot@1.0.65` 追従。

- **新機能**: Tab 補完 UI に対応
- **修正**: Free / Enterprise アカウント切替後にログインが失敗する問題を修正
- **修正**: アカウント切替後に AI モデルが正しく切り替わらない問題を修正

### Install

```sh
npm install -g @bash0816/copilot-termux@1.0.65
copilot-termux setup
copilot --version
```

---

## 1.0.63 — 2026-06-22 candidate（rollback用） / candidateタグ・rollback用

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
