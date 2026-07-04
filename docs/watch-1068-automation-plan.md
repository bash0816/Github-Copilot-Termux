# Watch 自動化 — 現状・実施済み・残件（2026-07-04 更新）

## 実施済み（1.0.68 サイクルで完了）

### STEP A: napi-audit.js ENOBUFS 修正 ✅

`scripts/napi-audit.js` の `extractCandidates()` を `strings` subprocess 方式から
`fs.readFileSync` + latin1 走査の自前スキャンに置き換え。
1.0.65 の実バイナリでパリティテスト（diff ゼロ）済み。

### MANIFEST-002 修正 ✅（2026-07-04、copilot-version-watch.yml に追加）

`config/manifest.json`（`lib/setup.js` が実際に読む、upstream tarball のバージョン・integrity を保持）が
Watch 自動化で更新されていなかった問題を修正。

**追加した処理（`copilot-version-watch.yml` の「Update manifest and package.json」ステップ）:**

```yaml
# config/manifest.json (MANIFEST-002: setup.js が実際に読むファイル)
INTEGRITY=$(npm view "@github/copilot-linuxmusl-arm64@${NEW_VERSION}" dist.integrity)
# version と integrity を更新
```

- `npm view` で integrity ハッシュを取得して `config/manifest.json` の `copilot.version` / `copilot.integrity` を更新
- `git add` 対象に `packages/copilot-termux/config/manifest.json` を追加
- integrity 取得失敗時は WARNING ログを出してスキップ（クラッシュさせない）

### latest_candidate_version の自動設定 ✅（2026-07-04）

Watch が `copilot-termux-release-manifest.json` の `latest_candidate_version` を
`null` ではなく `NEW_VERSION` に設定するよう変更。

**背景**: `latest_candidate_version: null` のまま `npm-package.yml publish=true` を実行すると
`VERSION !== CANDIDATE` チェックでエラーになり、今回のリリースで手動修正が必要になった。

---

## 残件（次サイクル以降）

### STEP B: Watch を「main 直接 push」→「候補ブランチ + PR」方式へ ⬜

- `config/copilot-audited-versions.json`（per-version 永続台帳）を新設
- `automation/copilot-<version>` ブランチを作成し PR を立てる
- 重複実行対策（既存ブランチ / オープン PR チェック）
- 現行の「Watch 成功 → 即 main push」より安全（NAPI 監査例外時も main に影響しない）

**スコープ注意**: 差し迫った 1.0.68 対応にはオーバースペック。次サイクルで検討。

### STEP C: README/RELEASES.md 生成スクリプト ⬜

- `config/copilot-audited-versions.json` の `status` フィールドから README の Status セクション・
  RELEASES.md のバージョン一覧を自動生成する（手動編集をやめる）
- MANIFEST-001 / UPDATE-004 のような「ドキュメントが実態と食い違う」問題を構造的に防ぐ

### P2: napi-audit.js タブ文字含み文字列の扱い ⬜

- 新実装はタブ文字を区切り文字として扱い、`strings -n 8` と微妙に挙動が異なる
- 現状の実バイナリでは問題なし。次回 napi-audit.js 改修時に対処

### P2: NAPI 監査省略時のログ出力 / artifact 添付 ⬜

- issue 本文が 50000 文字上限で切り詰められた場合、省略分を確認する手段がない
- 次回 Watch 改修時にログ出力またはワークフロー artifact 添付を追加

---

## 現在の Watch フロー（1.0.68 サイクル後の状態）

```
毎日 02:00 UTC (cron) または手動 workflow_dispatch
  ↓
新バージョン検出
  ↓
以下を自動更新して main に push:
  - copilot-termux-release-manifest.json（copilot_version, latest_candidate_version, candidate_state）
  - packages/copilot-termux/package.json（version）
  - config/manifest.json（copilot.version, copilot.integrity）  ← MANIFEST-002 修正分
  - config/napi-known-exports.json（NAPI 自動パッチ）
  - packages/copilot-termux/lib/platform-patch.js（自動パッチあれば）
  ↓
npm-package.yml を verify-only で自動 dispatch
  ↓
（手動）npm-package.yml publish=true → npm-publish 環境でユーザー承認
  ↓
（手動）別マシン（glibc mode）で実機確認
  ↓
（手動）npm-package.yml retag_latest=true → npm-publish 環境でユーザー承認
  ↓
README.md / RELEASES.md 手動更新（STEP C 導入まで）
```

---

## 変わらず手動が必須の範囲

- TUI 挙動バグ（login regression・PTY 動作等）の実機確認
- NAPI 監査で `newUnknown` が出た場合の platform-patch.js 実装
- npm publish / retag_latest の承認（`npm-publish` environment が必須）
- README / RELEASES.md 更新（STEP C 導入まで）
