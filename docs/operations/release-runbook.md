# copilot-termux Release Runbook

本ドキュメントは、`@bash0816/copilot-termux` の自動検知・検証・リリース・プロモーション手順を記載しています。

---

## リリースフロー概要

```
[自動Watch]
  ↓
[自動verify]
  ↓
[手動テスト (Device A)]
  ↓
[candidate publish (手動)]
  ↓
[Device B 検証 (ユーザー)]
  ↓
[latest promote (手動)]
  ↓
[GitHub Release 作成 (手動)]
```

---

## Step 1: Watch 自動検知（毎日 02:00 UTC）

**トリガー**: `copilot-version-watch.yml` スケジュール実行

**自動動作**:

1. `@github/copilot` の最新バージョンを npm registry から取得
2. `packages/copilot-termux/config/copilot-termux-release-manifest.json` の `copilot_version` と比較
3. 新バージョンが検知されたとき、以下を全て更新してコミット + push（PAT token 使用）:
   - `packages/copilot-termux/config/copilot-termux-release-manifest.json`:
     - `copilot_version`: 新バージョン
     - `latest_candidate_version`: **`null` のまま保持**（publish 成功後のみ設定される）
     - `candidate_state`: `'none'`
   - `packages/copilot-termux/package.json`: `version` フィールド
   - `packages/copilot-termux/config/manifest.json`: `copilot.version` と `copilot.integrity`
     - `copilot.integrity` は `npm view @github/copilot-linuxmusl-arm64@{version} dist.integrity` で取得
     - **取得失敗時は ワークフロー全体が exit 1 で失敗** → GitHub Actions issue が自動起票される
   - 変更をコミット + push の後、`npm-package.yml` を dispatch（`publish=false`, `retag_latest=false`）

**ログ確認**:

```bash
# Actions タブで最新の "Copilot version watch" ワークフローを確認
gh run list --repo bash0816/Github-Copilot-Termux --workflow copilot-version-watch.yml

# 詳細ログを表示
gh run view <RUN_ID> --log --repo bash0816/Github-Copilot-Termux
```

**トラブルシューティング - Watch 失敗時**:

- PAT token 有効期限切れ: `COPILOT_PRIVATE_ARTIFACT_TOKEN` secret を再生成・登録
- gh workflow dispatch 権限なし: repository settings で `Actions` に read-only ではなく write を許可
- npm registry 接続失敗: npm registry ステータスを確認（`npm view @github/copilot version` をローカルで実行）

---

## Step 2: 自動 verify 実行

**トリガー**: Step 1 の dispatch によって `npm-package.yml` の verify job が実行

**検証内容**:

1. `bionic-compat.so` 存在確認
   - AArch64 ELF バイナリ形式確認
   - Bionic シンボル確認（`bcmp`, `sdallocx`, `__errno_location`, `__xpg_strerror_r`）

2. npm tarball の生成確認
   - パッケージ化が正常に完了

3. tarball 内容の検証
   - 必須ファイルの包含確認
     - `lib/bionic-compat.so`
     - `scripts/bionic-compat.c`
     - `lib/setup.js`

**ログ確認**:

```bash
gh run view <RUN_ID> --log --repo bash0816/Github-Copilot-Termux
```

**verify 失敗時の対応**:

- bionic-compat.so 破損: `lib/bionic-compat.so` を再ビルドし、git push
- tarball 生成エラー: `packages/copilot-termux/package.json` の `files` フィールドが正しいか確認
- AArch64 確認失敗: runner が ARM64 マシンであることを確認

---

## Step 3: 手動テスト（Device A - 開発機）

**前提条件**:

- Node.js 18+
- npm CLI
- Device A（開発機、通常この実行者の端末）で実施

**手順**:

### 3a. tarball 生成

```bash
cd ~/Copilot-Termux
npm pack --pack-destination . packages/copilot-termux
# 出力例: bash0816-copilot-termux-1.0.63.tgz
```

### 3b. ローカルインストール

```bash
npm install -g ./bash0816-copilot-termux-1.0.63.tgz

# または、既にインストール済みの場合は再インストール
npm uninstall -g @bash0816/copilot-termux
npm install -g ./bash0816-copilot-termux-1.0.63.tgz
```

### 3c. Smoke test

```bash
# 1. バージョン確認
copilot --version
# 期待値: 1.0.63

# 2. プロンプト実行確認
copilot -p "say hello"
# 期待値: 
#   - AI レスポンスが表示される
#   - AI Credits カウント表示
#   - Token 使用量表示

# 3. TUI 起動確認
copilot
# 期待値:
#   - ターミナルUI が起動
#   - Ctrl+C で終了できる
#   - 入力プロンプトが表示される
```

### 3d. 詳細テスト（オプション）

```bash
# Device A でログイン状態確認
cat ~/.copilot-termux/current/auth_state.json | jq '.is_authenticated'

# 複雑なプロンプトでテスト
copilot -p "write a function to reverse a string in javascript"

# セットアップ再実行テスト
copilot-termux setup

# アンインストール・再インストール
npm uninstall -g @bash0816/copilot-termux
npm install -g ./bash0816-copilot-termux-1.0.63.tgz
copilot --version
```

**テスト完了時のメモ**:

- smoke test 全て成功 → Step 4 へ進行
- いずれかのテスト失敗 → リポジトリ issues を作成、修正後に再テスト

---

## Step 4: candidate publish（手動）

**前提条件**:

- Step 3 の smoke test 全て成功
- `COPILOT_PRIVATE_ARTIFACT_TOKEN` (PAT) が有効
- npm publish 権限あり（`@bash0816` scope）
- **publish チェック**: `packages/copilot-termux/config/copilot-termux-release-manifest.json` の `copilot_version` と `packages/copilot-termux/package.json` の `version` が一致していることを確認
  - Watch が両者を自動で同期しているため、ここまでで既に一致しているはず
  - 一致していない場合は Step 1 の Watch が失敗している可能性があり、エラーログを確認してから publish を進める

**実行コマンド**:

```bash
gh workflow run npm-package.yml \
  --repo bash0816/Github-Copilot-Termux \
  --field publish=true \
  --field retag_latest=false
```

**実行確認**:

```bash
# workflow run 一覧を確認
gh run list --repo bash0816/Github-Copilot-Termux --workflow npm-package.yml -L 5

# publish job のログを確認
gh run view <RUN_ID> --log --repo bash0816/Github-Copilot-Termux
```

**npm registry で確認**:

```bash
npm view @bash0816/copilot-termux@latest
npm view @bash0816/copilot-termux@candidate
npm dist-tags ls @bash0816/copilot-termux
```

期待値：

```
candidate: 1.0.63
latest: [前バージョン]
```

**publish 失敗時**:

- `NODE_AUTH_TOKEN` 無効: GitHub secrets の `NPM_TOKEN` を確認・再生成
- access denied: npm organization settings で `@bash0816/copilot-termux` の public publish を許可
- tarball 署名エラー: `npm publish --tag candidate --access public` をローカルで試行して原因特定

---

## Step 5: Device B 検証（ユーザー実施）

**検証者**: Device B ユーザー

**手順**:

```bash
# candidate タグでインストール
npm install -g @bash0816/copilot-termux@candidate

# smoke test 実行（Step 3c と同じ）
copilot --version
copilot -p "say hello"
copilot
```

**検証完了判定**:

- ✅ 全ての smoke test 成功 → Step 6 へ進行
- ❌ 問題発生 → issues 作成、修正確認後に再 publish

---

## Step 6: latest promote（手動）

**前提条件**:

- Step 5 の Device B 検証が成功
- `@bash0816/copilot-termux@candidate` が npm registry に存在
- `COPILOT_PRIVATE_ARTIFACT_TOKEN` が有効

**実行コマンド**:

```bash
gh workflow run npm-package.yml \
  --repo bash0816/Github-Copilot-Termux \
  --field publish=false \
  --field retag_latest=true \
  --field previous_audited_version="$(npm view @bash0816/copilot-termux dist-tags.latest)"
```

**npm registry で確認**:

```bash
npm dist-tags ls @bash0816/copilot-termux
# 期待値（例: previous_audited_version=1.0.63, candidate 版=1.0.65-1 の場合）:
# latest: 1.0.65-1     ← retag 対象の candidate 版に昇格
# candidate: 1.0.63    ← 旧 latest（previous_audited_version）に退避
```

**manifest 自動更新**:

- `npm-package.yml` の retag job が自動で `packages/copilot-termux/config/copilot-termux-release-manifest.json` を更新してコミット・push する
  - `latest_audited_version`: 昇格した版（旧 `latest_candidate_version`）
  - `latest_candidate_version`: 退避後の registry `candidate` dist-tag（＝旧 `latest`）
  - `previous_stable_version`: `previous_audited_version` 入力値
  - `candidate_state`: `"promoted"`
  - `last_updated`: 実行日

**確認**:

```bash
gh api repos/bash0816/Github-Copilot-Termux/contents/packages/copilot-termux/config/copilot-termux-release-manifest.json --jq '.content' | base64 -d | jq .latest_audited_version
```

---

## Step 7: GitHub Release 作成（手動）

**前提条件**:

- Step 6 の latest promote 完了
- 修正内容が `RELEASES.md` に記載済み

**注意事項**:

`release-finalize.yml` には既知のコマンドインジェクション脆弱性がある（`KNOWN-BUGS.md` CI-001 参照）。
**本ドキュメントの手順は `release-finalize.yml` を使わず、`--notes-file` を使う安全な方法です。**

**実行コマンド**:

```bash
# RELEASES.md から該当バージョンのセクションを抽出
VERSION="1.0.63"
grep -A 100 "^## ${VERSION}" RELEASES.md | grep -B 100 "^---" | head -n -1 > /tmp/release_notes.txt

# GitHub Release 作成（--notes-file を使用）
gh release create "v${VERSION}" \
  --repo bash0816/Github-Copilot-Termux \
  --title "v${VERSION}" \
  --notes-file /tmp/release_notes.txt
```

**確認**:

```bash
gh release view v1.0.63 --repo bash0816/Github-Copilot-Termux
```

---

## プラットフォームパッチ更新が必要になったとき

**シナリオ**: `lib/platform-patch.js` で Termux bionic バグ対応が必要な場合

### 修正手順

1. **`lib/platform-patch.js` を修正**
   ```bash
   # 既存修正を確認
   head -50 packages/copilot-termux/lib/platform-patch.js
   
   # 修正を追加実装
   nano packages/copilot-termux/lib/platform-patch.js
   ```

2. **修正内容を `RELEASES.md` に記載**
   ```markdown
   ## X.X.XX — 202X-XX-XX
   
   upstream `@github/copilot@X.X.XX` 追従。
   
   **Termux 固有の修正 / Termux-specific fixes**
   
   - **`xxx` 修正**: 説明...
   
   ### Install
   
   ```sh
   npm install -g @bash0816/copilot-termux@X.X.XX
   ```
   ```

3. **バージョンバンプ**
   ```bash
   # package.json と manifest の version を上げる
   # （例: 1.0.63 → 1.0.64）
   ```

4. **テスト実行**
   ```bash
   npm pack --pack-destination . packages/copilot-termux
   npm install -g ./bash0816-copilot-termux-1.0.64.tgz
   copilot -p "test"
   ```

5. **通常のリリースフロー実行**
   - Step 4 から Step 7 を実行

---

## トラブルシューティング

### `copilot: command not found`

**原因**: npm global bin path が PATH に含まれていない

**解決策**:

```bash
# npm の global bin 確認
npm config get prefix
# 出力例: /data/data/com.termux/files/usr/lib/node_modules/..

# PATH に追加（~/.bashrc または ~/.zshrc に追記）
export PATH="$(npm config get prefix)/bin:$PATH"

# shell 再起動後に確認
copilot --version
```

### `copilot-termux setup` が途中で止まる

**原因**: GitHub 認証失敗またはネットワークエラー

**解決策**:

```bash
# ログを確認
tail -50 ~/.copilot-termux/setup.log

# リトライ
copilot-termux setup --force

# 手動で auth state をリセット
rm -rf ~/.copilot-termux/current
copilot-termux setup
```

### TUI が起動しない（`copilot` コマンドが応答なし）

**原因**: PTY ネイティブモジュール `lib/native/pty.node` が不足している

**解決策**:

```bash
# 同梱ファイルを確認
find ~/.copilot-termux/current -name "pty.node" 2>/dev/null

# copilot-termux を再インストール
npm uninstall -g @bash0816/copilot-termux
npm install -g @bash0816/copilot-termux@latest

# PTY モジュール確認
ls -la ~/.copilot-termux/current/lib/native/
```

### AI レスポンスが出ない（-p で何も返らない）

**原因 1**: 認証トークン期限切れ

```bash
copilot-termux setup
```

**原因 2**: `platform-patch.js` の `responsesStreamDrive` が正しく実装されていない

```bash
# ログ確認
tail -100 ~/.copilot-termux/stderr.log

# 修正：lib/platform-patch.js の responsesStreamDrive セクションを確認
cat packages/copilot-termux/lib/platform-patch.js | grep -A 20 "responsesStreamDrive"
```

**原因 3**: Bionic 互換パッチが機能していない

```bash
# bionic-compat.so が正しくロードされているか確認
LD_PRELOAD=$(npm list -g @bash0816/copilot-termux --depth=0 | grep copilot-termux | awk '{print $NF}') LD_PRELOAD="${LD_PRELOAD}/lib/bionic-compat.so" ldd $(which node) | grep bionic
```

---

## チェックリスト - リリース完了時

- [ ] `@github/copilot` 新バージョン検知（自動または Watch workflow 再実行）
- [ ] Watch 成功確認:
  - [ ] `packages/copilot-termux/config/copilot-termux-release-manifest.json` の `copilot_version` が更新済み
  - [ ] `packages/copilot-termux/config/manifest.json` の `copilot.version` と `copilot.integrity` が更新済み
  - [ ] `packages/copilot-termux/package.json` の `version` が `copilot_version` と一致
- [ ] `npm-package.yml` verify 成功
- [ ] Device A smoke test 成功
  - [ ] `copilot --version`
  - [ ] `copilot -p "say hello"`
  - [ ] `copilot` TUI 起動
- [ ] `npm-package.yml` candidate publish 成功
- [ ] Device B smoke test 成功
- [ ] `npm-package.yml` latest promote 成功
- [ ] `packages/copilot-termux/config/copilot-termux-release-manifest.json` の `latest_audited_version` 更新確認
- [ ] GitHub Release 作成完了（`--notes-file` を使用して実行）
- [ ] `RELEASES.md` 最新化

---

## 自動化スケジュール

| 時刻 (UTC) | ジョブ | 頻度 | トリガー |
|-----------|------|-----|--------|
| 02:00 | copilot-version-watch.yml | 毎日 | cron |
| 随時 | npm-package.yml (verify) | 新バージョン検知時 | workflow dispatch (watch 内で実行) |
| 手動 | npm-package.yml (publish) | candidate/latest | gh workflow run |

---

## FAQ

**Q: Watch が失敗した（issue が自動起票された）**

A: 主な原因は `@github/copilot-linuxmusl-arm64` の integrity 取得失敗です。
   1. GitHub Actions issue のリンクからワークフローログを確認
   2. npm registry が一時的にダウンしている場合: 数分待ってから GitHub UI で「Re-run failed jobs」を実行
   3. パッケージ名が変更または新バージョン未公開の場合:
      - `npm view @github/copilot-linuxmusl-arm64@{VERSION} dist.integrity` を手動実行
      - 取得できない場合は `packages/copilot-termux/config/manifest.json` を手動で更新
      - コミット＆push してから Watch ワークフローを再実行（workflow_dispatch）

**Q: candidate タグでテストしたくない**

A: Step 4 をスキップし、RELEASES.md 確認後に直接 latest publish してください。（非推奨）

**Q: watch が毎日実行されるのは多すぎる**

A: `copilot-version-watch.yml` の `cron` を調整してください。例：`cron: '0 2 * * MON'`（週1回、月曜）

**Q: manifest の `candidate_state` はいつ更新される？**

A: `npm-package.yml` の publish job が自動更新します。
- candidate publish 時: `candidate_state = "published"` + `latest_candidate_version = {VERSION}`
- latest promote 時: `candidate_state = "promoted"`

**Q: Device A でテスト後、candidate タグを削除したい**

A: npm registry 上の candidate タグは保持し、最新バージョンが確定したら latest に promote してください。candidate タグの削除は非推奨です。

---

## 参考リンク

- `packages/copilot-termux/config/copilot-termux-release-manifest.json` — バージョン・ステート管理
- `packages/copilot-termux/package.json` — npm パッケージメタデータ
- `.github/workflows/copilot-version-watch.yml` — 自動検知ワークフロー
- `.github/workflows/npm-package.yml` — verify・publish ワークフロー
- `RELEASES.md` — リリースノート
- `lib/platform-patch.js` — Termux 固有パッチ実装
