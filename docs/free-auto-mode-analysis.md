# Free account Auto Mode 動作分析

最終更新: 2026-06-30（**1.0.65-2 で解決済み**）

---

## 解決策（1.0.65-2）

**根本原因**: `runtime.node`（musl variant）の tokio ランタイムが bionic libc の pthread ABI と非互換。
- `capiClientCreateModelSession`（native tokio HTTP）が "networking config not registered" エラーをスロー
- → auto mode 失敗 → "Auto-mode unavailable"

**解決手法** (`agy-termux` と同じアプローチ):
1. `copilot-termux setup` が `@github/copilot-linux-arm64` から glibc 版 `runtime.node` を取得
2. `copilot-termux setup` が Node.js v26.2.0 glibc linux-arm64 を取得
3. `bin/copilot` が glibc loader + glibc Node.js + glibc runtime.node を自動検出
4. glibc モードでは `platform-patch.js`/`bionic-compat.so` を一切使わず実行

```sh
exec env LD_PRELOAD="" \
  "$GLIBC_LD" --library-path "$GLIBC_LIBS" \
  "$GLIBC_NODE" \
  "$COPILOT_INDEX" \
  "$@"
```

**検証結果** (1.0.65-2 bionic Termux):
```
copilot -p "say ok"
→ ok  (AI Credits 2.65, 8s)  ✅
```

---

## 前提（ユーザー確認済み）

- PC copilot 1.0.65 Free account: `/model` ピッカーに `auto` のみ表示
- `auto` 選択 → API が haiku 4.5 を選ぶ（ユーザーが選ぶのではなく API が決める）
- ユーティリティ AI（gpt-4o-mini, gpt-4o, mai-code-1-flash-picker 等）は選択肢に出してはダメ
- アップデート機能は codex 同様：起動時チェック→次回起動時に適用

---

## PC での auto mode フロー（正常系）

```
copilot -p "say ok"
  → doResolve()
  → VVn(authInfo)
  → FUe(authInfo) → eT.createWithOAuthToken(url, integrationId, oauthToken, sessionId)
  → e.createModelSession()
  → x.capiClientCreateModelSession(nativeHandle, undefined, networkingConfigId)
    → POST /models/session {auto_mode: true, model_hints: []}
    → response: {session_token: "ghu_...", selected_model: "claude-haiku-4.5", ...}
  → mkt(n) → {sessionToken, selectedModel: "claude-haiku-4.5", ...}
  → 推論: model=goldeneye-free-auto or claude-haiku-4.5 + Copilot-Session-Token header?
```

---

## Bionic での問題（確認済み事実）

### 問題 1: capiClientCreateModelSession が失敗

- `modelHttpRegisterNetworkingConfig` は TOKIO_PATTERN で no-op → undefined を返す
- `Rk(this.baseURL)` = networkingConfigId が登録されていない状態
- `x.capiClientCreateModelSession(handle, undefined, undefinedConfigId)` → ネイティブが "networking config not registered" エラー
- SIGSEGV ではなく JS catchable error

### 問題 2: POST /models/session が 400

```bash
curl -X POST "https://api.githubcopilot.com/models/session" \
  -H "Authorization: Bearer {gho_oauth_token}" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Api-Version: 2026-07-01" \
  -H "Copilot-Integration-Id: copilot-developer-cli" \
  -d '{"auto_mode": true, "model_hints": []}'
→ 400 "Invalid request body"
```

試したバリエーション（全て 400）:
- `{"auto_mode": true, "model_hints": []}`
- `{"auto_mode": true, "model_hints": null}`
- `{"auto_mode": true, "model_hints": ["claude-haiku-4.5"]}`
- `{"auto_mode": true, "model_hints": [{"id": "auto"}]}`
- `{"auto_mode": true}` → 400 "Invalid request body"
- `{}` → 400 "Missing auto_mode field in request" ← `auto_mode` は必須確認済み

`model_hints` フィールド名は runtime.node の strings から確認済み。

### 問題 3: Copilot token が取得できない（Free）

```
GET https://api.github.com/copilot_internal/v2/token → 404
GET https://api.githubcopilot.com/copilot_internal/v2/token → 404
GET https://api.individual.githubcopilot.com/copilot_internal/v2/token → 404
GET https://proxy.individual.githubcopilot.com/copilot_internal/v2/token → 404
```

Free individual account では `/copilot_internal/v2/token` が存在しない。
Copilot token 取得の代替エンドポイント不明。

### 問題 4: Claude モデルが OAuth token では動作しない

```bash
# gpt-4o / gpt-4o-mini → 200 OK（OAuth token 動作確認済み）
curl -X POST .../chat/completions -d '{"model":"gpt-4o",...}' → 200

# claude-haiku-4.5 → 400 "model_not_supported"（OAuth token では不可）
curl -X POST .../chat/completions -d '{"model":"claude-haiku-4.5",...}' → 400
```

Claude モデルは Copilot token が必要とみられる。

### 問題 5: goldeneye-free-auto が /chat/completions で使えない

```
GET /models（OAuth token）→ goldeneye-free-auto はリストに含まれない
POST /chat/completions model=goldeneye-free-auto → 400 "model_not_available_for_integrator"
```

---

## 現在の実装（rev.9）の状態

| スタブ | 状態 |
|--------|------|
| `capiClientListModels` | JS stub（OAuth token で GET /models）→ 全モデル model_picker_enabled=false |
| `capiClientCreateModelSession` | スタブなし → native が networking config エラー |
| `modelsFilterToPicker` | native が [] → [] をそのまま返す（rev.9 の正解） |
| `modelResolverFirstAvailableDefaultFromOrder` | native null 時 gpt-4o-mini / gpt-4o にフォールバック（問題あり） |
| `capiClientPrepareRequestHeaders` | copilotToken があれば差し替え（Free では copilotToken=null） |

rev.9 での `copilot -p "say ok"` の結果:
1. `capiClientCreateModelSession` → networking config error
2. `modelListCache = []`（gir([]) = []）
3. "Auto-mode unavailable and no fallback model could be resolved."

---

## curl 調査結果（2026-06-30 実施）

### Free account の正しい API endpoint
```
/copilot_internal/user → endpoints.api = "https://api.individual.githubcopilot.com"
```
以降の POST /models/session は `api.individual.githubcopilot.com` が正しい URL。

### 認証挙動の確認

| Authorization | body | 結果 |
|---------------|------|------|
| なし | any | 400 "missing required Authorization header" |
| 偽トークン | any | 401 "AuthenticateToken authentication failed" |
| OAuth token | `{}` | 400 "Missing auto_mode field in request" |
| OAuth token | `{"auto_mode": true, ...}` | 400 "Invalid request body" |
| OAuth token | `{"auto_mode": false, ...}` | 400 "Invalid request body" |

**結論**: OAuth token の認証自体は通る（401 にならない）。
しかし `auto_mode: true` の POST /models/session は全パターン 400 になる。

### 試したすべての body バリエーション（全て 400）
- `{"auto_mode": true, "model_hints": null}`
- `{"auto_mode": true, "model_hints": []}`
- `{"auto_mode": true, "model_hints": ["claude-haiku-4.5"]}`
- `{"auto_mode": true}`
- `{"auto_mode": true, "client_kind": "oai"}`
- `{"auto_mode": true, "integration_id": "copilot-developer-cli"}`

### 試したヘッダー（全て 400）
- `Editor-Version: copilot-linuxmusl-arm64/1.0.65`
- `User-Agent: copilot-linuxmusl-arm64/1.0.65 ...`
- `OpenAI-Intent: conversation-agent`
- `X-Copilot-Traceparent: 00-...`
- `X-GitHub-UserAuthorization: token <oauth>`（単独では 400 missing Authorization）
- `X-Client-Machine-Id: ...`

### runtime.node strings 解析結果

POST /models/session の body fields（binary strings から確認）:
```
auto_mode model_hints json!
```
→ body は `{"auto_mode": bool, "model_hints": null_or_array}` で正しい。追加フィールドは不明。

POST /models/session のレスポンス fields（mkt() 関数から確認）:
```
session_token, selected_model, available_models, expires_at, discounted_costs
```

POST /models/session 後に使われるヘッダー:
- `Copilot-Session-Token: <session_token>` → 推論時に使用
- `/models/session/intent` → session token を使って intent を判定

### EXP-1 結果（2026-06-30）
- `modelHttpRegisterNetworkingConfig` を no-op から除外 → **SIGSEGV (exit 139)**
- → bionic では no-op 必須と確定

### 未解明事項

**なぜ OAuth token で POST /models/session が 400 になるか？**

仮説 A（有力）: サーバーが `auto_mode: true` に Copilot token を要求。OAuth token では 400 "Invalid request body" として拒否。
- PC native は `/copilot_internal/v2/token` 以外の別経路で Copilot token を取得している可能性
- Free 個人プランで `/copilot_internal/v2/token` → 全エンドポイント 404

仮説 B: body format の問題（可能性低: body は解析されている）

### 次に必要なこと

**glibc 端末（PC）での TC-4 実施**:
`copilot -p "say ok" 2>&1 | grep "\[TC4\]"` → `sessionJson=` の内容
- session_token の先頭（`ghu_` ? `ghs_` ? 別形式?）
- selected_model の実際の値
- API が成功するということは native が何か別の auth を使っている可能性大

---

## 制約

- 元のソースを基本にする（bionic で壊れている部分だけを JS で修正）
- ユーティリティ AI（gpt-4o-mini, gpt-4o, mai-code-1-flash-picker 等）は選択肢に出さない
- auto = API 側が決める（こちらで勝手にモデルを選ばない）
- TUI ピッカーには `auto` のみ表示（Free account）

---

## OAuth token で動作するもの（確認済み）

| エンドポイント | モデル | 結果 |
|----------------|--------|------|
| `/chat/completions` | `gpt-4o` | 200 OK |
| `/chat/completions` | `gpt-4o-mini` | 200 OK |
| `/chat/completions` | `claude-haiku-4.5` | 400 model_not_supported |
| `/chat/completions` | `goldeneye-free-auto` | 400 model_not_available |
| `POST /models/session` (api.githubcopilot.com) | - | 400 "Invalid request body" |
| `POST /models/session` (api.individual.githubcopilot.com) | - | 400 "Invalid request body" |
| `GET /models` (api.individual.githubcopilot.com) | - | 200 OK (30 models, 全て picker=false) |
