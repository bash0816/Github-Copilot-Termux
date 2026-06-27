# Known Bugs — 未解決バグ一覧

> **記録日**: 2026-06-27（最終更新: 2026-06-27）  
> **Opus レビュー**: 2026-06-27 実施済み  
> **状態**: AUTH-001 修正済み・enterprise 実機確認済み。MODEL-002 TUI テスト待ち。UPDATE-001 独立対応待ち。

---

## 共通根：copilotUser の不安定さ

**AUTH-001 / MODEL-001 / MODEL-002 は共通の根を持つ。**

`copilotUser`（`access_type_sku` / `copilot_plan` を含む）は `_buildAuthInfo()` 内の
`/copilot_internal/user` fetch でのみ取得される。この取得が失敗すると `copilotUser=null` になる。
`null` のまま権限フィルタ（`Mgn(models, access_type_sku, copilot_plan)`）が走ると、
権限外モデルが素通りし（MODEL-001）、モデル判定も不安定になる（MODEL-002）。

AUTH-001 → copilotUser 不安定 → MODEL-001/002 の連鎖。AUTH-001 の解決が最優先。

---

## AUTH-001: アカウント切り替え時の認証失敗

**重要度**: Critical  
**影響バージョン**: 1.0.64（1.0.65 未確認）

### 症状
- free アカウントでの初回 login は成功する
- `free → enterprise` へのアカウント切り替え後に login を実行すると失敗
- `enterprise → free` へのアカウント切り替え後も同様に失敗
- 一度失敗すると再認証できない状態になる

### 原因候補（有力度順、Opus レビュー 2026-06-27）

| # | 原因候補 | 該当箇所 | 有力度 |
|---|---------|---------|--------|
| 1 | **`process.env.COPILOT_API_URL` のグローバル残留**。enterprise で設定後、free 切替時に `/copilot_internal/user` が失敗するとクリアされず、`/models`・`authGetCopilotApiUrl` が旧 enterprise endpoint を叩く | `platform-patch.js:536`（set のみ、clear なし）/`:134`/`:153` | **高** |
| 2 | **env token 最優先で切替が反映されない**。`gh auth switch` しても `GITHUB_TOKEN/GH_TOKEN` が残っていれば `_readGhToken` は同じ token を返し、`cachedToken!==token` が成立せずキャッシュ無効化されない | `:876-889`, `:554` | **高** |
| 3 | **`authManagerGetCurrentAuthInfo` が token 再読込せず即返す**。`cachedInfo` があれば古い authInfo を返す | `:586-590` | 中 |
| 4 | **`authManagerLoginUser` の catch が旧 cachedInfo を消さない**。login 失敗時に旧アカウントが生存し「切替したのに前のまま」 | `:637` | 中 |
| 5 | **`authResolveAuthInfoFromToken` が常に `copilotUser:null`**。app.js がこの経路を使うと Mgn の権限フィルタが必ず欠落 | `:650-663` | 中（経路依存）|

> **注意**: token だけで切替を検知できない。free/enterprise ともに host=`https://github.com` で不変なので `cachedHost` は無力。
> env token が固定の場合、token も不変になり得るため token 比較だけでは切替を検知できない。

### ✅ 修正済み（2026-06-27）

`authManagerSwitchToAuth` を以下の方針で修正・コミット済み（commit 1d4ac59）：
1. `process.env.COPILOT_API_URL` をクリア
2. `/copilot_internal/user` を再 fetch して copilotUser を更新

また `/copilot_internal/v2/token` 経由の Copilot token 交換も追加（commit 8d18381）。
enterprise アカウントでは v2/token が 200 を返す場合があり、推論 API に必要。

### 3-step 実機確認（2026-06-27）

| ステップ | アカウント | 結果 |
|---------|----------|------|
| 1 | bash0816 (free) | "Auto-mode unavailable" ✓（期待動作） |
| 2 | yterai-ehc (enterprise) | claude-sonnet-4.6 で `copilot -p "1+1は"` → 成功 ✓ |
| 3 | bash0816 (free) に戻す | "Auto-mode unavailable" ✓（COPILOT_API_URL が正しくリセット） |

---

## MODEL-001: 本来見えないはずのモデルが表示される

**重要度**: High  
**影響バージョン**: 1.0.64（1.0.65 未確認）

### 症状
モデル選択 UI に、アカウント権限では使えないはずのモデルが表示される。

### 原因（Opus レビューで訂正済み）
当初の仮説（`modelsFilterToPicker` stub が主因）は**訂正**。

app.js の実際の処理：
```js
let p = await Ogn(Mgn(d.models, t.copilotUser?.access_type_sku, t.copilotUser?.copilot_plan), s);
// l_o(t) = modelsFilterToPicker(JSON.stringify(t))
return { models: l_o(p), unfilteredModels: p, ... }
```

- `Mgn(models, access_type_sku, copilot_plan)` が**アカウント権限フィルタ**を実施
- `modelsFilterToPicker`（l_o）はその後に「picker 有効サブセット」に絞るだけ

**真の原因**: `copilotUser`（`access_type_sku` / `copilot_plan`）が null / 古い / 別アカウント由来になり、`Mgn` が権限フィルタできない。
`modelsFilterToPicker` の pass-through stub は**副次要因**（picker 非対象が混ざるだけ）。

### ✅ 修正済み（2026-06-27）

AUTH-001 解決後に実施（commits 9604a52, 01bae51）：
- `modelsFilterToPicker` を native-first（fallback なし）に変更
- 権限外モデルフィルタ（`Mgn`）が copilotUser 安定化後に正常動作

### 実機確認（2026-06-27）

- free アカウント: 全モデル `model_picker_enabled=false` → `[]` → "Auto-mode unavailable"（期待動作）
- enterprise アカウント `yterai-ehc`: 8 モデルが picker 有効 → `copilot -p "1+1は"` → claude-sonnet-4.6 で正常動作 ✓

---

## MODEL-002: MCP 経由のアカウント権限取得が不安定

**重要度**: High  
**影響バージョン**: 1.0.64（1.0.65 未確認）

### 症状
モデル判定で MCP 経由にてアカウント権限を取得しているが不安定。

### 原因
AUTH-001 と連動。copilotUser が null になると権限情報が欠落する。
AUTH-001 修正済み。

### 現状
`-p` モード（新プロセス）では AUTH-001 修正後に正常動作を確認。
TUI モードの `/login` コマンド + アカウント切り替えは未確認。

---

## UPDATE-001: `/update` が公式 URL を参照してしまう

**重要度**: Medium  
**影響バージョン**: 1.0.64（1.0.65 未確認）

### 症状
TUI 内で `/update` を実行すると以下が表示される：
```
To update, run: `npm i -g @github/copilot@<version>`
```
正しくは `npm install -g @bash0816/copilot-termux` であるべき。

### 原因（app.js で特定済み）
```js
async function WEr(t, e) {
  let n = await B5t(t, e);
  let r = `npm i -g @github/copilot@${VEr(e)}`;
  return { kind: "add-timeline-entry", entry: { type: "info",
    text: `${n}\n\nTo update, run: \`${r}\``,
    prefillInput: `!${r}` } };
}
```
`WEr` 関数（minified）が `npm i -g @github/copilot@<version>` をハードコード。

### 修正方針（Opus 推奨）
`Module._load` フックで `app.js` のソースコードを限定スコープで置換する：
- 対象: `~/.copilot-termux/current/index.js`（または同等パス）に限定
- パターン: `/npm i -g @github\/copilot@\$\{[^}]+\}/`（一点置換）
- **置換件数 ≠ 1 の場合は無変更 + 警告**（upstream 変化検知を兼ねる）
- 置換後: `` `npm install -g @bash0816/copilot-termux` ``
- 優先度は Medium のまま、AUTH/MODEL 修正後で問題なし

---

## バグ優先度サマリー

| ID | 内容 | 重要度 | 修正前提 | 状態 |
|-----|------|--------|----------|------|
| AUTH-001 | free↔enterprise切り替えで認証失敗 | Critical | なし | ✅ 修正済み・3-step 実機確認済み |
| MODEL-001 | 権限外モデルが表示される | High | AUTH-001 | ✅ 修正済み・enterprise 実機確認済み |
| MODEL-002 | MCP経由の権限取得が不安定 | High | AUTH-001 | -p モード確認済み。TUI モード未確認 |
| UPDATE-001 | `/update`が`@github/copilot`を参照 | Medium | なし | 独立・後回し可 |

## 残作業

1. **MODEL-002 TUI テスト**: TUI モードで `/login` + アカウント切り替えを実機確認
2. **UPDATE-001**: Module._load フックで限定スコープ文字列置換（AUTH/MODEL 完了後）
3. **npm publish**: MODEL-002 TUI テスト完了 + UPDATE-001 対応後に candidate → latest

---

> **1.0.65 対応状況（2026-06-27）**:  
> AUTH-001・MODEL-001 修正済み。enterprise `-p` モード動作確認済み。  
> TUI モードの MODEL-002 確認と UPDATE-001 対応が残。
