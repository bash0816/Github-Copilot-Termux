# Watch自動化 — 1.0.69 サイクル記録（2026-07-08 更新）

## 概要

upstream @github/copilot **1.0.69** のWatch自動化・NAPI監査・実機検証完了。
GPT-5.5レビュー Go判定（candidate publish まで）取得。npm dist-tags 更新は保留中。

---

## 実施内容

### ✅ STEP A: Watch 自動検出・mainコミット（2026-07-08）

`copilot-version-watch.yml` が 1.0.69 を検出し以下を自動更新・mainへ直接コミット（commit `6f2f639daf40c8bc9f275680efa05d1815107f63`）：

- `copilot-termux-release-manifest.json`（copilot_version: 1.0.69）
- `packages/copilot-termux/package.json`（version: 1.0.69）
- `config/manifest.json`（copilot.version, integrity）
- `config/napi-known-exports.json`（NAPI自動パッチ）
- （platform-patch.js: 更新なし）

**注記**: STEP B（候補ブランチ + PR方式）はまだ未実装（watch-1068-automation-plan.md の残件参照）。
現行のmain直接push運用が継続中。

### ✅ STEP B: NAPI監査（2026-07-08）

`scripts/napi-audit.js` を実行。結果：

| カテゴリ | 件数 | 詳細 |
|---------|------|------|
| **newTokio** | 3件 | `networkFetchNextRequestId`、`sessionStoreExecuteReadOnlyAsync`、`sessionStoreInsertAssistantUsageEventWithRuntimeDefaults` → **自動パッチ適用済み** (`tokio_noop_prefixes` 更新) |
| **newPendingGitAsync** | 1件 | `gitHashFilesPrefixedAsync` → **config/napi-known-exports.json のpending_git_async_stubs に追加のみ** ⚠️ JSスタブ未実装 |
| **newUnknown** | 137件 | 自動 behavioral_stubs に追加・GitHub Issue #11 として記録済み（OPEN状態） |

**audit品質注記（GPT-5.5レビューより）**:
- `scripts/napi-audit.js` の `extractCandidates()` が printable ASCII run を丸ごと1候補にするため、
  `napi_has_elementnapi_get_version` のような隣接シンボルの結合誤抽出が実際に発生。
- ただし既存の behavioral_stubs（2742件時点）にも同様の結合ゴミ文字列が多数含まれており、
  今回の137件だけが質的に異常ではない。runtime への実害は報告なし。

### ✅ STEP C: 実機スモークテスト（2026-07-08、このマシンで実施）

```sh
npm pack
npm install -g ./copilot-termux-1.0.69.tgz

copilot-termux setup
# → "glibc node ready" ✓
# → "copilot 1.0.69 ready" ✓

copilot --version
# → 1.0.69 ✓

copilot -p "1+1は"
# → 正常応答（Claude via api.githubcopilot.com） ✓

# クラッシュなし、全て PASS
```

### ✅ STEP D: GPT-5.5 コーディングレビュー（2026-07-08）

**レビュー対象**: commit 6f2f639daf40c8bc9f275680efa05d1815107f63 の差分
+ 関連する既存ファイル（napi-audit.js、config/napi-known-exports.json、behavioral_stubs など）

**レビュー結果**: **Go判定**（candidate publish まで）

**Blocker**: なし

**Non-blocker（既知・影響軽微）**:

1. **audit.js の隣接シンボル結合誤抽出**
   - 既存の behavioral_stubs に同様のゴミが多数含まれる。今回の137件だけが異常ではない。
   - runtime 実害なし。次回 audit.js 改修時の対象に含める（P2）。

2. **gitHashFilesPrefixedAsync の未実装スタブ**
   - pending_git_async_stubs に追加済み（config/napi-known-exports.json）。
   - **ただし JSスタブは実装されていない**（JS層でのmock実装なし）。
   - 1.0.69 の app.js では SnapshotManager がファイルスナップショット作成時に実呼び出しする箇所がある。
   - 既存 pending_git_async 32件と同じ運用線上。**candidate → latest 昇格前に、「変更ファイルあり・snapshot/rewind有効」条件での実機確認が必要**。

3. **プロセス課題（次サイクル以降の改善対象）**
   - `copilot-version-watch.yml` がmainへ直接コミットしている点はプロセス上の課題。
   - STEP B（候補ブランチ + PR方式へ）の実装で対処予定（watch-1068-automation-plan.md 参照）。

**判定**: **Go（candidate publish のGo）** / latest 昇格は条件付き（下記の「残件」セクション参照）

---

## 残件（次ステップ）

### MUST: gitHashFilesPrefixedAsync の実機確認（latest昇格前）

**条件**: candidate → latest へ昇格させる**前に**、以下の環境条件で実機確認が必須。

- 「ファイルを新規作成 / 削除」した状態で copilot を実行（snapshot 初期化）
- TUI で `/snapshot` コマンドを実行（rewind 機能）
- クラッシュ・エラー出力がないことを確認

**理由**: `gitHashFilesPrefixedAsync` は pending_git_async スタブで代替実装されており、
実際のgit file hash 取得が失敗する可能性がある。snapshot/rewind は内部的にこの情報を使用。

**参考**: 既存の pending_git_async（32件）も同じ運用線上。GitHub Issue #11 の一部。

### P2: audit.js 隣接シンボル結合誤抽出（次回audit.js改修時）

既存 behavioral_stubs との整合性を保つ観点から、優先度は低（non-blocker）。
次回 napi-audit.js 改修時に合わせて対処。

### P2: STEP B 実装（次サイクル以降）

watch-1068-automation-plan.md の「STEP B」参照：
- `config/copilot-audited-versions.json`（per-version 永続台帳）を新設
- `automation/copilot-<version>` ブランチ + PR 方式へ移行
- 重複実行対策・変更の段階的レビュー化

---

## 現在のWatchフロー（1.0.69以降）

```
毎日 02:00 UTC (cron) または手動 workflow_dispatch
  ↓
新バージョン検出（例: 1.0.69）
  ↓
以下を自動更新して main に push:
  - copilot-termux-release-manifest.json
  - packages/copilot-termux/package.json
  - config/manifest.json
  - config/napi-known-exports.json
  - platform-patch.js（必要に応じて）
  ↓
npm-package.yml を verify-only で自動 dispatch
  ↓
[ユーザー] npm-package.yml publish=true → npm-publish 環境で承認
  ↓
[必須: candidate発行後、latest昇格前に実機確認]
  「ファイル変更 + /snapshot / /rewind」の環境で TUI テスト実施
  ↓
[ユーザー] npm-package.yml retag_latest=true → npm-publish 環境で承認
  ↓
[ユーザー] README.md / RELEASES.md 手動更新（STEP C 導入まで）
```

---

## 関連Issue・ドキュメント

- **Issue #11**: newUnknown 137件の behavioral_stubs 自動追加（OPEN）
- **watch-1068-automation-plan.md**: STEP B・C の実装計画・残件記録
- **KNOWN-BUGS.md**: バグ・その他の未解決課題

---

## テスト観点

- ✅ tgz スモークテスト: `npm pack → install -g → copilot --version / -p` で正常応答確認済み
- ⬜ gitHashFilesPrefixedAsync 実機確認: candidate 発行後、latest 昇格前に実施予定
- ⬜ TUI snapshot/rewind テスト: 同上

