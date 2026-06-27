# Smoke Test — リリース前動作確認手順

> **対象バージョン**: 1.0.65〜  
> **最終更新**: 2026-06-28

---

## アカウント権限マトリクス

GitHub Copilot の権限は Chat とエージェント（Agent）の 2 種類ある。

| プラン | Chat（`copilot` TUI） | エージェント（`copilot -p`） |
|--------|----------------------|---------------------------|
| **Free** | ✅ 動作（auto mode のみ、モデル選択不可） | ❌ 権限なし |
| **Enterprise** | ✅ 動作（モデル選択可） | ✅ 動作 |

- **`copilot -p`（エージェントモード）** は Enterprise のみ。Free で実行すると権限エラーになる
- Free の Chat は 2026-06-24 から model picker 廃止。auto mode のみ使用可能
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
- モデル選択画面が出ない（auto mode のみ、`model_picker_enabled=true` のモデルがゼロのため）
- チャットを送信すると応答が返ってくる

**確認ポイント**:
- ❌ `CAPIError: 400 The requested model is not supported` が出ないこと
- ❌ `Auto-mode unavailable and no fallback model could be resolved` が出ないこと（`goldeneye-free-auto` が `/models` に存在する場合）

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
| `modelsFilterToPicker` | `nativeCount` が Enterprise では > 0 か |
| `modelResolver:fallback` | Free で `goldeneye-free-auto` が見つかるか |

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
