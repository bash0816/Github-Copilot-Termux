## 1.0.72 — 2026-07-21 🚀 Latest / 最新版

upstream `@github/copilot@1.0.72` 追従。

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---
## 1.0.71 — 2026-07-17 / 旧版

upstream `@github/copilot@1.0.71` 追従。

**変更内容**

- upstream の内部改善に追従。今回のバージョンでは Termux 向けの追加修正はありません
- Free / Enterprise 両アカウントで TUI・`-p` モードの動作を実機確認済み

**既知の問題**

- 前バージョンからの既知の問題は引き続き未確定。詳細は [`docs/KNOWN-BUGS.md`](docs/KNOWN-BUGS.md) 参照

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.70 — 2026-07-12 / 旧版

upstream `@github/copilot@1.0.70` 追従。

**修正内容**

- **`copilot -p` が異常に遅い問題を修正**（AGENT-001）: 内部のネットワーク処理呼び出しの引数不整合により、通常数十秒で終わる処理が最大16分近くかかる場合がありました。修正により通常の速度に戻っています
- **一部の環境で MCP 接続・モデル一覧取得時にクラッシュする問題を修正**（MCP-BIONIC-001）: 対象は `copilot-termux setup` を実施していない一部のフォールバック環境のみで、通常セットアップ済みの環境には影響しません。該当環境ではクラッシュせず、明確なエラーメッセージを返すようになりました

**既知の問題**

- 前バージョンからの既知の問題は引き続き未確定。詳細は [`docs/KNOWN-BUGS.md`](docs/KNOWN-BUGS.md) 参照

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.69 — 2026-07-08 / 旧版

upstream `@github/copilot@1.0.69` 追従。

**変更内容**

- upstream の内部改善に追従。今回のバージョンでは Termux 向けの追加修正はありません
- ファイル変更を伴う操作(スナップショット・巻き戻し機能)を実機で動作確認済み

**既知の問題**

- 前バージョンからの既知の問題は引き続き未確定。詳細は [`docs/KNOWN-BUGS.md`](docs/KNOWN-BUGS.md) 参照

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.68-1 — 2026-07-07 / 旧版

upstream `@github/copilot@1.0.68` 追従（wrapper バージョンは `1.0.68-1`）。1.0.68 からの追加修正。

**修正内容**

- **Free TUI で auto モードしか選べず 400 エラーになる問題を修正**（BUG-NEW-1）: bionic libc の pthread ABI が native ランタイムと非互換だったことが根本原因と判明し、glibc mode（glibc 版 Node.js + glibc 版ネイティブモジュールを別途取得して起動）に変更。実機 TUI 確認済み
- **MCP 経由のアカウント権限取得が不安定な問題を修正**（MODEL-002）: アカウント切り替え時に権限情報（copilotUser）が古いまま残る問題（AUTH-001 と共通根）を修正。TUI でのアカウント切り替え（Enterprise ↔ Free）を実機確認済み
- **`copilot update` がフォーク独自パッチを古い npm latest へ自動ダウングレードする問題を修正**（UPDATE-007）: バージョン比較ロジックが fork 独自の `-N` サフィックス運用（正式版リリース後の追加パッチ）を一般的な semver のプレリリース運用と誤認していたため発生。実機で `copilot update` が正しく動作することを確認

**既知の問題**

- **アカウント切り替え直後の TUI footer「AIC used」表示が疑問視されている**（AIC-001、未確定）: Enterprise → Free 切り替え後に AI 消費量表示が出る挙動について、正常かどうか未切り分けのまま記録。詳細は [`docs/KNOWN-BUGS.md`](docs/KNOWN-BUGS.md) 参照。npm publish のブロッカーにはしていません

### Install

```sh
npm install -g @bash0816/copilot-termux@latest
copilot-termux setup
copilot --version
```

---

## 1.0.68 — 2026-07-04 / 旧版

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
