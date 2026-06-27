# Known Bugs — 未解決バグ一覧

> **記録日**: 2026-06-27  
> **Opus レビュー**: 2026-06-27 実施済み  
> **状態**: 1.0.64 対応コードはコミット済みだが、以下のバグにより npm publish をスキップ。  
> 1.0.65 リリース前に修正が必要。

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

### 修正方針（Opus 確認済み）
`authManagerSwitchToAuth` でキャッシュクリアするだけでは**不十分**。
切替時に以下の両方が必要：
1. `process.env.COPILOT_API_URL` をクリア
2. `/copilot_internal/user` を再 fetch して copilotUser を更新

### 調査手順（計装ファースト）

**Step 1: デバッグ計装を追加**（`COPILOT_TERMUX_DEBUG_AUTH=1` で stderr に JSON 1行）
- `_readGhToken`: token hash 先頭8桁 + source(`env`/`gh`/`null`)
- `_buildAuthInfo`: hostUri、`/user` status+login、`/copilot_internal/user` status、`access_type_sku`、`copilot_plan`、`endpoints.api`
- `_resolveOrCache`: uuid、cache hit/miss、cachedToken hash、新 token hash
- `authManagerLoginUser`: login 引数、成功/失敗、失敗時 cachedInfo の残存有無
- `capiClientListModels`: 使用 baseUrl、models 件数

**Step 2: 4パターンで再現**（候補の切り分け）
1. env token **なし** + `gh auth switch` で free→enterprise→free（候補2 を除外/確定）
2. `GITHUB_TOKEN` **固定あり** + `gh auth switch`（候補2 を確定）
3. `GITHUB_TOKEN` を free/enterprise で**明示変更**
4. enterprise で `/copilot_internal/user` が**失敗する** scope 条件（候補1 を確定）

**Step 3: 判定基準**
切替直後に **token hash・login・copilotUser・COPILOT_API_URL が同一アカウント由来で揃うか**。
一つでも旧値なら共通根が確定。

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

### 修正方針
AUTH-001 の解決（copilotUser 安定化）が前提。その後：
- native `modelsFilterToPicker` を native-first で呼び出す
- native が空（`[]`）かつ copilotUser が健全（access_type_sku/copilot_plan あり）の場合のみ全 index fallback を許容
- **copilotUser 欠落時は全 index fallback せず、native 空を尊重 + 警告ログ**（権限外漏洩を防ぐ）

> `model_picker_enabled=false 問題` は 1.0.63 時点の API 挙動に基づく観測。現行 API での再検証が必須。

---

## MODEL-002: MCP 経由のアカウント権限取得が不安定

**重要度**: High  
**影響バージョン**: 1.0.64（1.0.65 未確認）

### 症状
モデル判定で MCP 経由にてアカウント権限を取得しているが不安定。

### 原因
AUTH-001 と連動。copilotUser が null になると権限情報が欠落する。
AUTH-001 修正後に再評価する。

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
| AUTH-001 | free↔enterprise切り替えで認証失敗 | Critical | なし | 計装→再現待ち |
| MODEL-001 | 権限外モデルが表示される | High | AUTH-001 | AUTH-001 解決後に着手 |
| MODEL-002 | MCP経由の権限取得が不安定 | High | AUTH-001 | AUTH-001 解決後に再評価 |
| UPDATE-001 | `/update`が`@github/copilot`を参照 | Medium | なし | 独立・後回し可 |

## 推奨対応順序

1. **AUTH-001 計装** → デバッグログで根本原因を特定（enterprise 実機テスト環境が必要）
2. **AUTH-001 修正**: COPILOT_API_URL クリア + copilotUser 再 fetch を切替時に実装
3. **MODEL-001**: copilotUser 安定化後に modelsFilterToPicker を native-first 化（現行 API での model_picker_enabled=false 再検証を含む）
4. **MODEL-002**: AUTH-001 修正後に再評価
5. **UPDATE-001**: Module._load フックで限定スコープ文字列置換

---

> **1.0.65 での確認状況**: 上記バグが 1.0.65 でも発生するかは未確認。  
> 実機スモークテスト（enterprise アカウントでの認証含む）が必須。
