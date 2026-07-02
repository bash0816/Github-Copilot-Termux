# Smoke Test — リリース前動作確認手順

> **対象バージョン**: 1.0.65〜  
> **最終更新**: 2026-06-28

---

## アカウント権限マトリクス

GitHub Copilot の権限は Chat とエージェント（Agent）の 2 種類ある。

| プラン | Chat（`copilot` TUI） | エージェント（`copilot -p`） |
|--------|----------------------|---------------------------|
| **Free** | ✅ 動作（`policy.state=enabled` モデルが picker に表示される） | ❌ 権限なし |
| **Enterprise** | ✅ 動作（モデル選択可） | ✅ 動作 |

- **`copilot -p`（エージェントモード）** は Enterprise のみ。Free で実行すると権限エラーになる
- Free の Chat は全モデル `model_picker_enabled=false` だが、`policy.state=enabled` かつ denylist 外のモデルが picker に表示される（platform-patch.js フォールバック）
- Enterprise の Chat はモデル選択あり（`model_picker_enabled: true` のモデルが表示される）

---

## スモークテスト手順

### 前提

- Free アカウント（`bash0816`）と Enterprise アカウント（`yterai-ehc`）を用意
- `copilot` コマンドが現在テスト対象バージョンであることを確認:
  ```
  copilot --version
  ```

---

### TC-1: Free — Chat (TUI)

```bash
copilot
```

**期待動作**:
- TUI が起動する
- `policy.state=enabled` かつ denylist 外のモデルが picker に表示される（`modelsFilterToPicker` フォールバック）
- チャットを送信すると応答が返ってくる

**確認ポイント**:
- ❌ `Auto-mode unavailable and no fallback model could be resolved` が出ないこと
- ❌ `gpt-4.1` / `gpt-4.1-2025-04-14` が picker に表示されないこと（denylist 除外）
- デバッグログで `modelsFilterToPicker:fallback` が出ること（picker フォールバック動作確認）

---

### TC-2: Free — エージェント（`-p`）

```bash
copilot -p "1+1は"
```

**期待動作**:
- エージェント権限がないため、エラーが出て終了する
- エラーメッセージに権限不足の旨が含まれる

**確認ポイント**:
- ❌ クラッシュ（SIGSEGV 等）しないこと
- ❌ 無限ループしないこと

---

### TC-3: Enterprise — Chat (TUI)

アカウントを Enterprise に切り替えてから:

```bash
copilot
```

**期待動作**:
- TUI が起動する
- モデル選択画面に `model_picker_enabled: true` のモデルが複数表示される（Enterprise では 8 件程度）
- モデルを選択してチャット送信 → 応答が返ってくる

**確認ポイント**:
- ❌ `ProxyResponseError: HTTP 421` が出ないこと
- ❌ `Error loading model list` が出ないこと

---

### TC-4: Enterprise — エージェント（`-p`）

```bash
copilot -p "1+1は"
```

**期待動作**:
- エージェントが起動し、質問に対して回答が返ってくる

**確認ポイント**:
- ✅ 応答が返ってくること
- ❌ `CAPIError: 400` が出ないこと
- ❌ クラッシュしないこと

---

### TC-5: アカウント切り替え（Enterprise → Free）

1. Enterprise でログイン状態から開始
2. TUI 内で `/login` コマンド → Free アカウントに切り替え
3. または `copilot` 再起動後に Free アカウントで認証

**期待動作**:
- Free に切り替えた後、TC-1 と同じ動作になること
- Enterprise の `COPILOT_API_URL`（proxy URL）が残留しないこと

**確認ポイント**:
- ❌ 切り替え後に `ProxyResponseError: HTTP 421` が出ないこと
- ❌ 切り替え後に Enterprise モデルが Free 画面に表示されないこと

---

### TC-6: アカウント切り替え（Free → Enterprise）

1. Free でログイン状態から開始
2. TUI 内で `/login` コマンド → Enterprise アカウントに切り替え

**期待動作**:
- Enterprise に切り替えた後、TC-3/TC-4 と同じ動作になること

---

### copilot update 機能のテストケース (UPDATE-002)

#### TC-U1: registry に新バージョンあり → 実際にインストール実行

前提: 現在のローカルバージョン < npm registry latest

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- `Updating to <新バージョン>...` メッセージが stderr に表示される
- `npm install -g --prefix <prefix> @bash0816/copilot-termux@<新バージョン>` が実行される
- インストール成功時は exit 0
- インストール失敗時は手動実行コマンドが stderr に表示されて exit 1

**確認ポイント**:
- ✅ 実際にローカル package.json のバージョンが更新されていること
- ❌ rollback メッセージが出ないこと

---

#### TC-U2: ローカル > registry (latest/candidate) → 誤った rollback 案内なし

前提: ローカルが npm registry より進んでいる（開発ビルド状態）

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- `Already on latest version: <ローカルバージョン>` メッセージが stderr に表示される
- exit 0（正常終了）
- 「rollback to stable」のような誤った案内は出ない

**確認ポイント**:
- 🔴 バグ修正確認: 以前は `runUpdate()` の `!targetVer && isPrerelease(currentVersion)` 分岐で誤った rollback メッセージが出ていた。修正後は常に `Already on latest version` で統一

---

#### TC-U3: ローカルと registry が同一バージョン → 更新なし

前提: ローカル `1.0.65` = registry latest `1.0.65`

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- `Already on latest version: 1.0.65` メッセージが stderr に表示される
- exit 0（正常終了）

---

#### TC-U4: registry 取得失敗（ネットワーク切断等）

前提: ネットワーク切断または npm registry が一時的に不可用

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- `Failed to check for updates: <エラー理由>` メッセージが stderr に表示される
- `Run manually: DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix <prefix> @bash0816/copilot-termux@latest` が stderr に表示される
- exit 1（エラー終了）

**確認ポイント**:
- ❌ クラッシュしないこと

---

#### TC-U5: 安定版（prerelease でない）では candidate を見ない

前提: ローカル `1.0.65`（prerelease なし）、registry: latest `1.0.64`、candidate `1.0.66-1`

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- candidate `1.0.66-1` より新しいという判定をしない
- `Already on latest version: 1.0.65` を表示
- exit 0

**確認ポイント**:
- `resolveTarget()` の判定: `isPrerelease(currentVersion)` が false のため candidate fetch を実行しない（L102-112 の条件）

---

#### TC-U6: prerelease 表記のローカルでは candidate と latest のうちより新しい方へ更新

前提: ローカル `1.0.65-1`（prerelease）、registry: latest `1.0.64`、candidate `1.0.66-1`

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- candidate タグも取得して比較（L102-112）
- latest `1.0.64` と candidate `1.0.66-1` のうち newer である `1.0.66-1` へ更新しようとする
- または「latest より新しいバージョンが candidate にあれば candidate へ」という判定

**確認ポイント**:
- `compareVersions('1.0.66-1', '1.0.64') > 0` が true になっていること

---

#### TC-U7: latest 取得成功・candidate 取得失敗 → latest のみで処理継続

前提: npm registry から latest は取得できるが candidate が 404（存在しない）

```bash
node packages/copilot-termux/lib/check-updates.js update
```

**期待動作**:
- candidate fetch が失敗しても無視（L109-111 の catch）
- latest のバージョン比較のみで判定を続ける
- エラーメッセージは出ない（正常動作）
- exit 0 または 1（バージョン比較結果による）

**確認ポイント**:
- ❌ candidate タグの取得失敗で全体が fail しないこと

---

#### TC-U8: `--dry-run` フラグで実際のインストール実行なし・コマンド文字列のみ出力

```bash
node packages/copilot-termux/lib/check-updates.js update --dry-run
```

**期待動作**:
- 正確な `npm install -g --prefix <prefix> @bash0816/copilot-termux@<version>` コマンド文字列が stdout に出力される
- npm install は実際には実行されない（stdio='inherit' されない）
- exit 0

**確認ポイント**:
- prefix が正しく動的導出されていること（`path.resolve(__dirname, '../../../../..')`で 5 段上）
- インストール対象パッケージ名が `@bash0816/copilot-termux` であること
- version が registry から取得した target version であること

---

## デバッグログの確認方法

詳細ログを有効にして起動:

```bash
GITHUB_COPILOT_VERBOSITY=debug copilot -p "テスト" 2>&1 | head -100
```

注目すべきログキー:

| キー | 内容 |
|------|------|
| `buildAuthInfo:/copilot_internal/user` | `access_type_sku`, `copilot_plan`, `endpoints_api` が含まれるか |
| `buildAuthInfo:/copilot_internal/v2/token` | copilot token が取得できているか |
| `capiClientListModels:fetch` | `fetchUrl`, `copilotUrl` が `api.githubcopilot.com` になっているか |
| `buildAuthInfo:/copilot_internal/v2/token` (失敗時) | `status` と `body` がログに出るか（Free は 404 が期待値） |

---

## 合否基準

| テストケース | 合格条件 |
|-------------|---------|
| TC-1 Free Chat | 起動・応答成功。400 エラーなし |
| TC-2 Free `-p` | 権限エラーが出て正常終了 |
| TC-3 Enterprise Chat | モデル選択表示。応答成功 |
| TC-4 Enterprise `-p` | 応答成功 |
| TC-5 Enterprise→Free 切替 | 切替後 TC-1 相当の動作 |
| TC-6 Free→Enterprise 切替 | 切替後 TC-3/4 相当の動作 |

TC-1〜TC-4 が全合格でリリース可。TC-5/TC-6 は余裕があれば確認。
