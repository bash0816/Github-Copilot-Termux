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

### ✅ 修正済み（2026-06-27・2026-06-28 追記）

AUTH-001 解決後に実施（commits 9604a52, 01bae51）：
- `modelsFilterToPicker` を native-first（fallback なし）に変更
- 権限外モデルフィルタ（`Mgn`）が copilotUser 安定化後に正常動作

**2026-06-28 追記（BUG-NEW-1 対応で再修正）**  
Free プランは全モデル `model_picker_enabled=false` → native `[]` → auto-only → 400 の問題が判明。  
`modelsFilterToPicker` に `policy.state=enabled` フォールバックを追加（denylist で `gpt-4.1` 系を除外）。

### 実機確認（2026-06-27）

- free アカウント: 修正後 → `policy.state=enabled` かつ denylist 外のモデルが picker に表示される想定（TC-1 確認待ち）
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

### ✅ 修正済み（2026-06-27、commit 6bd05d6）

`Module._extensions['.js']` フックで `~/.copilot-termux/current/index.js` ロード時にのみ適用：
- パターン: `` /`npm i -g @github\/copilot@\$\{[^}]+\}`/g `` （1件一致のみ置換）
- 置換後: `` `npm install -g @bash0816/copilot-termux` ``
- パターン件数 ≠ 1 の場合は警告のみで無変更（upstream 変化検知）

---

---

## BUG-NEW-1: Free TUI auto モードで 400 エラー

**重要度**: High  
**影響バージョン**: 1.0.65

### 症状
Free TUI 起動後 `Auto-mode unavailable and no fallback model could be resolved.`

### 根本原因（2026-06-28 確定）
1. Free は全 28 モデルが `model_picker_enabled=false` → native `modelsFilterToPicker` が `[]` を返す
2. picker 空 → app.js が auto モードにフォールバック → `auto` モデルで 400 `model_not_supported`
3. `gpt-4.1`（policy=enabled）はサポート終了のため代替不可

### 試行済みの誤ったアプローチ（削除済み）
- `modelResolverFirstAvailableDefaultFromOrder` をインターセプトして auto → gpt-5-mini に差し替え
  - 問題: gpt-5-mini も Free で 400。モデルの返り値を書き換えるのは禁止（ユーザー指摘）

### ✅ 修正（2026-06-28 実装済み）
`modelsFilterToPicker` に `policy.state=enabled` フォールバックを追加：
- native が `[]` を返した場合のみ発動
- `policy.state === 'enabled'` のモデルインデックスを返す
- denylist（`_FREE_PICKER_DENYLIST`）で `gpt-4.1`, `gpt-4.1-2025-04-14` を除外
- `apply(this, args)` パターンで native の将来的なシグネチャ変更に対応

また、`copilotTokenExpiry` の正規化バグを修正：
- `expires_at` 欠落/NaN 時に `0`（永久有効）になるバグ → token あり時は 28 分デフォルト TTL を設定
- `_normalizeCopilotTokenExpiry` ヘルパーで一元管理

### 確認手順（TC-1）
```bash
gh auth switch --user bash0816
COPILOT_TERMUX_DEBUG_AUTH=1 copilot 2>&1 | head -80
# modelsFilterToPicker:fallback ログで enabled モデル数を確認
```

---

---

## BUG-NEW-3: capiClientEnableModelPolicy / capiClientCreateModelSession がスタブなし

**重要度**: High
**影響バージョン**: 1.0.65
**発見日**: 2026-06-28（ログ調査で判明）

### 症状
Free TUI でモデルを選択した際、`policy.state: "disabled"` のモデルに対して
`capiClientEnableModelPolicy` が Rust ネイティブで呼ばれ、API が 400 を返す。
→ app.js がエラーとして扱い、モデルが使えない状態になる可能性がある。

### app.js の呼び出しフロー
```js
async enableModelPolicy(e) {
  r = await x.capiClientEnableModelPolicy(nativeHandle, e, token)
  // 400 → { success: false, canBeEnabled: false, error: ... }
  // Free: 全モデル policy.state=disabled → 常に 400
}

async createModelSession(e) {
  r = await x.capiClientCreateModelSession(nativeHandle, e, token)
  // モデルセッション作成 → TUI チャット前に呼ばれる可能性
}
```

### 問題
- `capiClientEnableModelPolicy` は HTTP fetch（tokio）を使う可能性 → bionic で SIGSEGV リスク
- `napi-known-exports.json` に未記載 → スタブなし
- Free アカウントでは必ず 400 が返る → app.js がエラー処理に入る
- **ユーザー指摘**: 「Free の方には 400 を 200 に変えるものがあるはず」

### 修正方針（未実装）
`capiClientEnableModelPolicy` に JSスタブを追加：
- Free（全 policy=disabled）: `{ success: false, canBeEnabled: false, error: null }` を返す
  → app.js は「有効化不可」として処理を継続（エラー扱いにしない）
- Enterprise: `{ success: true }` を返す（native が正常動作すると仮定）

または：
- native に委ねて、クラッシュした場合のみ fallback する

**要調査**: TUI でモデル選択時のログを確認して実際に呼ばれているか確認する。

---

## MANIFEST-001: wrapper バージョンと upstream ダウンロード先の不整合

**重要度**: Medium  
**影響バージョン**: 1.0.65, 1.0.65-1  
**発見日**: 2026-06-29

### 症状

`@bash0816/copilot-termux@1.0.65`（および `1.0.65-1`）をインストールすると、
`copilot --version` が `1.0.64` と表示される。

### 根本原因

`config/manifest.json`（upstream のダウンロード先を指定）が `1.0.65` に更新されていない。

```json
{
  "copilot": {
    "package": "@github/copilot-linuxmusl-arm64",
    "version": "1.0.64"  ← 1.0.65 になっていない
  }
}
```

`github-actions[bot]` による自動バンプ commit（`9444cfe`）が `package.json` のみ更新し、
`config/manifest.json` の更新を漏らした。

### 影響

- wrapper は `1.0.65-1` と名乗るが、実際には upstream `1.0.64` バイナリを実行している
- AUTH-001 修正（`platform-patch.js` 側）は upstream バージョンに依存しないため動作に問題なし
- `copilot --version` 表示が混乱を招く

### 1.0.65 インストール済みユーザーへの対処

現時点では**機能上の問題はない**（wrapper の `platform-patch.js` は upstream バージョンに依存しない）。
ただし、意図せず 1.0.64 upstream を使っている状態であることをユーザーに知らせる必要がある。

**確認方法**:
```bash
cat ~/.copilot-termux/current/package.json | grep '"version"'
# → "1.0.64" と表示されれば MANIFEST-001 の影響下にある
```

**暫定回避策**（upstream 1.0.65 を手動インストールしたい場合）:
```bash
# upstream を手動で更新（MANIFEST-001 修正前の暫定）
cd ~/.copilot-termux
npm install @github/copilot-linuxmusl-arm64@1.0.65
# ※ setup スクリプトが current を上書きするため、次回 setup 実行で 1.0.64 に戻る点に注意
```

**恒久対応**: MANIFEST-001 修正版（1.0.65-2 または 1.0.66）を publish 後に `npm install -g @bash0816/copilot-termux@latest` で更新する。

### 修正方針（未実装）

`config/manifest.json` の `version` を `1.0.65` に更新し、
`@github/copilot-linuxmusl-arm64@1.0.65` の integrity hash を確認して設定する。
その後 tgz を再ビルドして publish。自動バンプ bot のスクリプトも `manifest.json` を同時更新するよう修正する。

---

## バグ優先度サマリー

| ID | 内容 | 重要度 | 修正前提 | 状態 |
|-----|------|--------|----------|------|
| AUTH-001 | free↔enterprise切り替えで認証失敗 | Critical | なし | ✅ 修正済み・3-step 実機確認済み |
| MODEL-001 | 権限外モデルが表示される | High | AUTH-001 | ✅ 修正済み・enterprise 実機確認済み |
| MODEL-002 | MCP経由の権限取得が不安定 | High | AUTH-001 | -p モード確認済み。TUI モード未確認 |
| UPDATE-001 | `/update`が`@github/copilot`を参照 | Medium | なし | ✅ 修正済み（commit 6bd05d6） |
| BUG-NEW-1 | Free TUI auto モードで 400 | High | MODEL-001 | 🔍 修正実装済み・TC-1 実機確認待ち |
| MANIFEST-001 | wrapper 1.0.65 が upstream 1.0.64 をダウンロードする | Medium | なし | 🔜 未修正 |

## 残作業

1. **TC-1 実機確認**: Free TUI で `modelsFilterToPicker:fallback` ログ確認・チャット送信テスト
2. **MODEL-002 TUI テスト**: TUI モードで `/login` + アカウント切り替えを実機確認（ユーザー作業）
3. **npm publish**: 全 TC 確認完了後に `npm-package.yml` を candidate タグで trigger → ユーザー承認 → latest

---

> **1.0.65 対応状況（2026-06-28）**:  
> AUTH-001・MODEL-001・UPDATE-001 修正済み。enterprise `-p`/TUI 動作確認済み。  
> BUG-NEW-1（Free auto 400）調査中。MODEL-002 TUI 確認待ち。
