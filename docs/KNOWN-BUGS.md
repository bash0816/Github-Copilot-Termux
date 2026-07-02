# Known Bugs — 未解決バグ一覧

> **記録日**: 2026-06-27（最終更新: 2026-07-03）  
> **Opus レビュー**: 2026-06-27 実施済み  
> **状態**: AUTH-001 修正済み・enterprise 実機確認済み。UPDATE-001・UPDATE-003 は `registerHooks()` 方式で修正・実機検証済み（2026-07-03、ユーザーTUI目視確認済み）。UPDATE-004 新規発見（未修正・低優先度）。

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
| 5 | ~~**`authResolveAuthInfoFromToken` が常に `copilotUser:null`**~~ ✅ bionic のみ JS stub（copilotUser:null）を適用。glibc mode では native を使用（SSL_CERT_FILE 修正済みのため TLS 動作）。2026-07-01 修正 | `:1042` | 解消 |

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

### 🔴🔴 2026-07-02 追記: 修正アプローチ自体が根本的に成立しないことが判明（Haiku実装後・自己検証で発覚）

STEP2レビュー（codex Go判定）を経て `Module._extensions['.js']` フックのファイル名判定・パターンを
修正する実装をHaikuに委任したが、**実装後に自分（Sonnet）で実機に近い形で再現テストしたところ、
このフック自体が index.js / app.js のどちらに対しても一度も発火しないことが判明した**。
UPDATE-003 の修正も同じフックに相乗りする設計だったため、同様に無効。

**原因**: `~/.copilot-termux/<version>/package.json` に `"type": "module"` が明記されており、
`index.js` と `app.js` は両方とも Node の **ESM ローダー**でロードされる（`index.js` 自身が
静的 `import` を使用しており、構造的にもESM確定）。`Module._extensions['.js']` は **CommonJS
ローダー専用のフック**であり、ESM としてロードされるファイルのコンパイルには一切関与しない。

**実証方法**: 同一ディレクトリ構成（`package.json` に `"type":"module"`、`current` シンボリックリンク、
`--require` でCJSフックスクリプトをプリロード）を最小再現し、`node --require hook.js current/index.js`
を実行。フック内に仕込んだ `console.log('[HOOK FIRED]', filename)` が **一度も出力されなかった**
（index.js 用にもapp.js用にも）ことを確認。

**過去記録の訂正**: 2026-06-27 commit `6bd05d6` を「✅ 修正済み」と記録していたが、これは誤りだった。
そもそもこの手法（`Module._extensions['.js']` によるコンパイル時文字列パッチ）は
**ESM 化されている upstream app.js に対しては原理的に機能しない**。

**なぜ他の patch（AUTH-001 の `globalThis.fetch` 上書き、`process.platform` 上書き等）は動いているのか**:
それらは module loading pipeline（compile-time のソーステキスト差し替え）ではなく、
**`globalThis` やプロセス環境などの共有ランタイム状態を上書きする方式**であり、
ESM/CJS どちらでロードされていても影響が及ぶ。UPDATE-001/003 だけが「ソーステキストの
文字列置換」という、ESM モジュールには通用しない手法を取っていたのが根本原因。

**今回のHaiku実装の扱い**: `packages/copilot-termux/lib/platform-patch.js` 末尾に追加された
`isTargetCopilotAppJs` / `patchAppJsContent` 関数自体（純粋な文字列変換ロジック）は
単体では正しく動作する（実際の `app.js` の内容に対して単体テスト済み）。問題は
**それを呼び出す `Module._extensions['.js']` フックが実行時に一切トリガーされない**点のみ。
関数自体は次の正しい実装方式に転用できる可能性があるため、コードは残置し、
フック機構のみを正しいものに置き換える方針とする（詳細は「今後の修正方針」参照）。

### ✅ 修正方式確定（2026-07-02・codex STEP2再レビュー Go・実機検証済み）

**採用: 候補A — `node:module` の `registerHooks()`（同期 ESM Loader Hook API）に一本化**

- Node の同期版 ESM Loader Hooks API `registerHooks()`（Node v22.15.0 / v23.5.0 で追加、
  v26系では Stability 1.2 Release Candidate）を使い、`load` フックで `app.js` のソーステキストを
  実行前に書き換える。非同期版の `register()` は v25.9.0 以降 deprecated かつ `--import` 必須・
  別ファイル(.mjs)必須・登録タイミング競合ありのため不採用。`registerHooks()` は
  **既存の `--require platform-patch.js` のまま**、CJSファイル内から直接呼べる。
- UPDATE-001・UPDATE-003 とも同じフックに一本化する（codex 指摘: fetch 傍受方式に分けると
  修正面が2系統になり保守性が落ちる。fetch方式はURL・HTTPクライアント実装が変わると外れる
  ため、今回は不採用・将来のフォールバック候補として保留のみ）。

**実機検証済み（2026-07-02、Sonnetが実施）**:
実際にインストール済みの `~/.copilot-termux/current/index.js`・`app.js`（本物、書き換えなし）に対し、
検証用の `registerHooks()` フックを `--require` で読み込んで実行したところ:
```
[TEST-HOOK] intercepted file:///.../1.0.65/app.js
[TEST-HOOK] UPDATE-001 patched OK
[TEST-HOOK] UPDATE-003 patched OK
```
と出力され、両パターンとも実際に検出・置換されることを確認した（この後 native addon 未検出で
プロセスは終了するが、これは検証用フックが platform-patch.js の他の必須パッチ（native addon
パス差し替え等）を含んでいないためで、今回の修正とは無関係）。

**実装方針（Haiku委任時に厳守させる項目・codex指摘反映済み）**:
- `registerHooks` が存在しない Node（バージョン未満・将来の削除）ではフィーチャー検出で
  スキップし、パッチなしでフォールバックする:
  `const { registerHooks } = require('module'); if (typeof registerHooks !== 'function') { console.warn(...); }`
- 多重登録防止ガードを入れる（`registerHooks()` は複数回登録可能で LIFO チェーンになるため、
  二重登録すると同じ置換が複数回走る）: `globalThis.__COPILOT_TERMUX_ESM_PATCH_REGISTERED__` 等の
  プロセス内フラグでガードする
- URL 判定は `url.endsWith('app.js')` のような雑な判定ではなく、`fileURLToPath(url)` してから
  `path.basename(filename) === 'app.js'` かつ `.copilot-termux` パスセグメントを含むことを確認する
  （symlink・実パスどちらでも判定できる。UPDATE-001の旧実装と同じ考え方を流用）
- `result.source` は `string | ArrayBuffer | TypedArray | undefined` を取りうる。`undefined` は
  即 return。文字列でない場合は `Buffer.from(source).toString('utf8')` に変換してから処理する
- 対象外のファイルでは `source` のデコード・変換を一切行わず `nextLoad` の結果をそのまま返す
  （全モジュールロードにフックがかかるため、対象外パスの処理コストは最小限にする）
- パターン一致件数チェック（既存の安全策）は維持: 期待1件以外は無変更・`console.warn` のみ
- パッチ適用の成否をログで判別可能にする（今回のような「動いていると誤認する」事故の再発防止）

**未検証・残課題（実装完了の条件ではないが記録必須）**:
- **glibc mode 側の Node バージョンが未確認**（このマシンでは glibc 環境自体が壊れており
  `libc.so: invalid ELF header` で検証不能）。`registerHooks()` が glibc Node で使えない
  バージョンの場合、フィーチャー検出により自動的にパッチなしへフォールバックするが、
  別マシン（glibc mode 検証用）で `node -v` と実際の動作確認が必要
- 実際に tgz を `npm install -g` してグローバルインストールした状態で `/update` 表示・
  起動時バナーの両方を実機目視確認すること（[[feedback_smoke_test_real_install.md]]）

### 実装完了・STEP8コーディングレビュー結果（2026-07-02）

Haiku が実装し、Sonnet が独立に以下を再検証した（Haiku の自己申告を鵜呑みにせず、
別途 probe を注入した実機テストと関数直接呼び出しの両方で再確認済み）:
- 実際にインストール済みの本物の `app.js` に対し `patchAppJsSource` が UPDATE-001/003 とも
  1件ずつ検出・置換することを確認
- 実際の `bin/copilot` と同じ起動方法（`node --require platform-patch.js index.js`）で
  `registerHooks()` の `load` フックが本物の `app.js` に対して実際に発火することを、
  一時的な probe ログ注入により確認（native addon 未検出によるクラッシュはこの検証と無関係）
- `platform-patch.hook-verify.js`（19項目、E2E含む）を独立実行し全PASSを確認

**codex(gpt-5.5) STEP8コーディングレビュー結果**: 重大なブロッカーなし。
- Medium: `isTargetCopilotAppJsUrl` の判定が `.copilot-termux` セグメント包含 + basename一致
  だけでは `.copilot-termux/<version>/node_modules/**/app.js` のような無関係な深い階層にも
  誤反応しうる → **修正済み**。`.copilot-termux` セグメントの直後2セグメント目
  （`<version-or-current>/app.js`）である場合のみ許可するよう変更し、修正後も
  全19項目PASS・実機再検証OKを確認
- Low（残存・受容）: UPDATE-003 の正規表現は upstream minify 形状に依存するため、
  upstream のビルドが変わると静かに無効化されうる。ただし既存の安全策（件数チェック＋
  `console.warn`）によりクラッシュはせず、通知バナーが残るだけの劣化に留まる。
  リリースごとに実インストール済み `app.js` への1マッチ確認を運用でカバーする
- `Object.assign({}, result, { source: patched })` による `format` 等の他プロパティ破壊は
  なしと確認

### ✅ 正式スモークテスト完了（2026-07-03・実インストール経由）

devリポジトリから `npm pack` → `DISABLE_INSTALLATION_CHECKS=true npm install -g <tgz>` で
この端末の `@bash0816/copilot-termux`（グローバル）を修正版 `1.0.65-1` に再インストールし、
`bin/copilot` 経由（LD_PRELOAD・bionic-compat.so 込みの実際の起動経路）で確認した。

- インストール済み `platform-patch.js` が devリポジトリの修正版と完全一致（diff確認）
- `copilot -p "say ok"` → 正常応答（既存機能への回帰なし）
- `copilot --version` → `console.warn`（UPDATE-001/003パターン不一致時の警告）が一切出力されず、
  両パターンとも exactly 1件マッチで正常置換されたことを確認
- インストール済みパッケージの `patchAppJsSource` を実際の `~/.copilot-termux/current/app.js`
  （本物）に対して実行し、公式インストール文字列の除去・fork名への置換・upstream通知バナー
  ロジックの無効化（`false`への置換）を確認

**完了しているもの**: STEP2設計レビュー（codex Go）・実装（Haiku）・STEP8コーディングレビュー
（codex Go）・メカニズム検証（Sonnet独立実施）・正式スモークテスト（実インストール経由、上記）

**残っているもの**:
- TUIでの目視確認（`/update`実行時の表示文言、起動時通知バナーの非表示）。
  対話的操作が必要なため、ユーザーが直接確認する
- glibc mode 側の `registerHooks()` 対応バージョン確認（別マシン必要、前述の通り）
- commit / push / npm publish はまだ未実施（ユーザー承認待ち）

### STEP2ルール化（codex提案・今後全プロジェクトに適用検討）

今回、STEP2レビュー（1周目）で Go 判定が出たにもかかわらず、実装後に「そもそも修正方式が
成立しない」という前提の誤りが発覚した。再発防止のため、実装着手前に以下を必須化する:
- 実際のロード方式を確認する（`package.json` の `type` フィールド・entrypoint・
  静的 import か CJS require か・実際に使われる Node 実行ファイル）
- 本番と同じ構成（`--require`／symlink／`package.json type`／entrypoint）での最小再現で、
  フックが実際に発火することをログまたは副作用で確認してから本実装に着手する
  （「動くはず」という推測だけでSTEP2を通過させない）
- 複数ランタイムが存在する場合（今回は bionic node と glibc node）は両方の `node -v` と
  API存在確認を行う
- 「パッチが当たったか」を自動判定できるテストを用意する（起動が成功した・例外が出ない、
  だけでは不十分）
- 対象外ファイルに誤爆しないネガティブテストも用意する

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

### 🔴 再発（2026-07-02・ユーザー実機確認で判明）: commit 6bd05d6 のパッチは実際には一度も発火していない

**症状再現**: ユーザーが実機 TUI で `/update` を実行したところ、修正済みのはずの
`npm i -g @github/copilot@1.0.68` が今も表示された（`@bash0816/copilot-termux` ではない）。

**根本原因（2026-07-02 検証済み・2点の複合バグ）**:

1. **対象ファイルの取り違え**: フックの発火条件は `` /`npm i -g @github\/copilot@\$\{[^}]+\}`/g `` を
   `~/.copilot-termux/current/index.js` の**コンパイル内容**から探すが、この文字列は実際には
   `app.js` にのみ存在する（`index.js` 内は 0 件、`app.js` 内は 1 件、実機で確認済み）。
   ファイル名条件が一致しても中身に対象文字列がなければ `matches.length === 0` → else 分岐で
   `console.warn(...skipping patch)` のみで無置換となる。

2. **symlink 解決によりファイル名条件がそもそも一致しない（より根本的）**:
   `~/.copilot-termux/current` は常にバージョンディレクトリ（例: `1.0.65`）へのシンボリックリンク。
   Node は `require`/動的 `import` 時に既定で symlink を実体パスへ解決してから
   `Module._extensions['.js']` にファイル名を渡す（`--preserve-symlinks` 系フラグ未指定時の既定動作）。
   このため `Module._extensions['.js']` が実際に受け取るファイル名は
   `~/.copilot-termux/1.0.65/index.js`（または `app.js`）であり、**正規表現が要求する
   リテラル `current/` セグメントは実行時のファイル名に一切現れない**。
   最小再現コードで実証済み（symlink 経由で `require` した場合、コンパイルフックに渡る
   `filename` は symlink 解決後の実パスであることを確認）。

   → 1点目を直しても 2点目が残る限り、このフックは**理論上一度も発火し得ない**。

**影響**: UPDATE-001 は 2026-06-27 に「修正済み」と記録されていたが、実際には無効なパッチであり、
本バグはリリース以降ずっと再発し続けていた（"修正済み"の誤記録）。

**修正方針（未実装・STEP2 レビュー待ち）**:
- ファイル名判定を実パスベースに変更する。例: `path.basename(filename) === 'app.js'` かつ
  `path.basename(path.dirname(filename))` が `~/.copilot-termux/` 配下のバージョンディレクトリ
  （またはそれを realpath 解決した `current` の実体）と一致するかで判定する。
  あるいは「`.copilot-termux` 配下の `app.js` である」という緩い条件＋内容パターンの
  1件一致チェック（既存の安全策）に一本化し、`current` リテラル一致という壊れやすい前提を排除する。
- 修正後は実際にグローバルインストール経由・実コマンド `/update` で目視確認する
  （[[feedback_smoke_test_real_install.md]] の教訓：ソース直接実行の確認だけで済ませない）。
- UPDATE-003（下記）の修正フックもこの直し方に相乗りできる設計にする。

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
**影響バージョン**: 1.0.65（1.0.65-1 は影響なし・下記「修正済み」参照）  
**発見日**: 2026-06-29
**状態**: ✅ 修正済み（2026-06-29、commit `1097c77`）。ドキュメント記載の更新漏れを2026-07-03に是正。

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

### 修正済み（2026-07-03 記録・実際の修正は 2026-06-29 commit `1097c77`）

commit `1097c77`（`fix(MANIFEST-001): update upstream to @github/copilot-linuxmusl-arm64@1.0.65`）で
`config/manifest.json` の `version` を `1.0.65` に更新済み（現在の値: `1.0.65`、
integrity hash も npm view で取得したものに更新済み）。この commit は 1.0.65-1 のビルドに
含まれている（`git merge-base --is-ancestor 1097c77 HEAD` で確認済み）。

**実機確認済み（2026-07-03）**: この端末の `@bash0816/copilot-termux@1.0.65-1` インストール環境で
`copilot --version` → `GitHub Copilot CLI 1.0.65.`（`1.0.64` ではない）を確認。

本セクションが長期間「未修正」のまま記載されていたのは、修正 commit 自体は入っていたが
`docs/KNOWN-BUGS.md` の更新が追いついていなかったため（ドキュメントと実態の乖離）。
1.0.65-1 の README/RELEASES.md 更新作業（2026-07-03）で気づいて是正。

---

## UPDATE-002: `copilot update` が npm パッケージ自体を更新しない

**重要度**: High  
**影響バージョン**: 1.0.65-1 以前  
**発見日**: 2026-07-02（VERIFY-REQUEST.md の TC 後に判明）

### 症状

```
$ copilot update
Update is not supported when running js directly.
```

`copilot-termux update` も `setup()` と同一で、npm パッケージ (`@bash0816/copilot-termux`) 自体は更新されない。

### 根本原因

- `bin/copilot` は `~/.copilot-termux/current/index.js` に `"$@"` を丸ごと渡す設計
- upstream の `update` サブコマンドは「JS 直接実行モード」を検知してブロック
- `bin/copilot-termux` の `update` は `setup()` と同一実装（内部 copilot バイナリの更新のみ）
- `npm install -g @bash0816/copilot-termux@latest` を手動実行する手段しかなく、かつ `--prefix` を指定しないと正しいインストール先に入らない

### ✅ 修正済み（2026-07-02）

`lib/check-updates.js` を新規作成し、以下を実装：
- npm registry から `latest` / `candidate` タグを確認してバージョン比較（semver 軽量自前実装）
- prefix を `__dirname` から動的に取得（`path.resolve(__dirname, '../../../../..')`）して `npm install -g --prefix <prefix>` を実行
- 24h TTL キャッシュで起動時の通知（`notify` モード）
- npm 失敗時に手動コマンドを stderr に表示
- `module.exports = { runUpdate, runNotify }` で `bin/copilot-termux` から利用可能

`bin/copilot` は `CACHE_DIR` チェックより前に `update` をインターセプトして `check-updates.js` を呼ぶ。  
`bin/copilot-termux` の `update` は `runUpdate()` にルーティング。

**codex（gpt-5.5）レビュー指摘（2026-07-02）**:
1. 🔴 prefix 導出が 2 段ずれ → `'../../../../..'` に修正
2. 🔴 `copilot update` 挿入位置が CURRENT チェックより後 → 前に移動
3. 🟡 semver 文字列比較で壊れる → 軽量自前実装
4. 🟡 candidate タグの条件: stable ユーザーを candidate に上げない
5. 🟡 notify は 24h TTL キャッシュ必須

### スモークテスト追加（2026-07-02）

これまで `copilot update` 機能のスモークテストが一度も実施されていませんでした。
今回、`docs/SMOKE-TEST.md` に UPDATE-002 対応テストケース **TC-U1〜U8** を追加し、
Termux 実機（bionic mode）で全ケース実行し **全て Pass** を確認しました（2026-07-02）。
テスト対象・期待動作・実施結果の詳細は [docs/SMOKE-TEST.md#copilot-update-機能のテストケース-update-002](./SMOKE-TEST.md#copilot-update-機能のテストケース-update-002) を参照してください。

### 追加バグ修正（2026-07-02）

`runUpdate()` 内の `!targetVer` 分岐で問題が判明しました。

**問題**: ローカル開発ビルドが npm registry 公開版より進んでいる **正常な状態** で、
以前の実装が `isPrerelease(currentVersion)` 判定により「rollback to stable」という
誤ったメッセージを出していました。

**原因**: `!targetVer` 判定時に `isPrerelease(currentVersion)` 分岐が存在し、
ローカルが prerelease 表記を持つ場合に誤った rollback 案内が出るロジックでした。

**修正**: 常に `Already on latest version: ${currentVersion}` で統一。
registry より新しいローカルビルドの状態を正しく「最新版」として表示します。

GPT-5.5 コードレビューで Go 判定を得ました。詳細は TC-U2（ローカル > registry）を参照。

### ⚠️ 検証手法の不備と実機再確認（2026-07-02）

**発端**: ユーザーが実機（Termux-A, bionic mode）で `copilot update` を実行したところ、修正済みのはずの rollback 誤案内メッセージが再現した。「この端末でインストールしてテストしているのか」「スモークテストも怪しい」と指摘を受けた。

**判明した事実**:
- TC-U1〜U8 は `node packages/copilot-termux/lib/check-updates.js update` で**開発リポジトリのソースファイルを直接実行**して確認したものであり、実際に `npm install -g` でグローバルインストールした `@bash0816/copilot-termux` パッケージ・実コマンド `copilot update` 経由での確認ではなかった。
- 修正コミット `abf28a7`（rollback 誤案内バグ修正）は dev repo にコミットされたのみで、`origin/main` 未 push・Private repo（配布用）未マージ・dist tgz 未再ビルド・この端末への再インストール未実施だった。
- そのため、この端末に実際にインストールされていたパッケージ（Private repo `476c845` 時点の tgz、`package.json` version `1.0.65-1`）の `lib/check-updates.js` は**修正前のコード**のままで、`isPrerelease(currentVersion)` 分岐による誤 rollback 案内が実際に再現した。
- 「TC-U1〜U8 全て Pass」という記録は誤りではないが、グローバルインストール経路・実コマンド経由の検証を含んでいなかった点で不十分だった。

**実施した再検証（2026-07-02）**:
1. この端末のグローバルインストール済みパッケージをスクラッチコピーし、`lib/check-updates.js` を dev repo の修正版に差し替え
2. `DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix <prefix> <scratch dir>` で実際にグローバル再インストール
3. 実コマンド `copilot update` を実行 → `Already on latest version: 1.0.65-1`・exit 0・rollback 案内なしを確認（✅ Pass）
4. `copilot -p "say ok"` で既存機能に影響がないことも確認（✅ Pass）

**注意**: この再検証は**ローカル検証専用のスクラッチ差し替え**であり、正式リリースではない。正式リリースには以下が必須（未実施）:
- dev repo `abf28a7` 以降のコミット（11 件、`origin/main` に対して先行中）を push
- Private repo への反映・dist tgz 再ビルド
- npm publish（`candidate` → ユーザー承認 → `latest`）

**教訓**: ソースファイル直接実行によるテストは「ロジックが正しいか」の確認にしかならず、「実際にユーザーが使うインストール済みバイナリ経由で動くか」の確認にはならない。スモークテストは可能な限り実際のグローバルインストール経路（`npm install -g` → 実コマンド）で行うこと。

---

## UPDATE-003: 起動時通知バナーが upstream 公式リポジトリのバージョンを参照する

**重要度**: Medium
**影響バージョン**: 1.0.65（1.0.63 以前も同一コード路であれば影響の可能性）
**発見日**: 2026-07-02（ユーザーがTUI起動時バナー `v1.0.68 available · run /update` を指摘）

### 症状

TUI 起動時のステータスバー / 通知に以下が表示される：
```
v1.0.68 available · run /update
```
この時点で `@bash0816/copilot-termux` の npm dist-tags は `candidate/latest/previous_stable` すべて `1.0.63`、
インストール済みローカルは `1.0.65`。`1.0.68` はどちらにも該当しない。

### 原因（app.js で特定済み）

`~/.copilot-termux/current/app.js` 内に以下のハードコードがある：
```js
owner:"github",repo:"copilot-cli"
```
これを使い `GET /repos/{owner}/{repo}/releases/latest` を `api.github.com` に対して実行し、
返ってきた `tag_name` を現在バージョンと `g$.gt()`（semver gt）で比較。新しければ
```js
t.sendUpdateNotification(`${c.tag_name} available \xB7 run /update`)
```
を呼んでバナー表示している。**参照先が upstream 公式リポジトリ `github/copilot-cli` 固定であり、
fork（`@bash0816/copilot-termux`）自身のリリースチャンネルを見ていない。**

UPDATE-001（`/update` 実行時の「インストールコマンド文字列」= `WEr()` 関数）とは別のコードパス。
UPDATE-001 は「表示テキスト」の修正のみで、この「バージョン比較・通知バナー」のロジックには手を付けていない。
`lib/check-updates.js`（UPDATE-002 で新設、`copilot update` CLI サブコマンド用）も TUI 起動時バナーには使われておらず、対象外。

### 影響

- fork ユーザーに対し、実際には存在しない・関係のない「upstream の新バージョン」を通知し続ける
- 通知に従って `/update` を実行しても、UPDATE-001 パッチにより実際にインストールされるのは `@bash0816/copilot-termux`（fork）であり、バナーの言う「upstream v1.0.68」にはならない → 表示と実際の動作が矛盾し続ける

### 修正方針（STEP2 codex(gpt-5.5) レビュー済み・2026-07-02・案A採用）

**案A（採用）**: upstream release チェック〜通知ロジック（`owner:"github",repo:"copilot-cli"` を使う
`GET /repos/.../releases/latest` 呼び出しと、それに続く `sendUpdateNotification` 呼び出し）を
`app.js` コンパイル時パッチで無効化し、バナー自体を出さない。

**却下した代案**:
- 案B（fork 自身の npm dist-tags 比較に差し替え）: minified `app.js` 内の async/network/semver/通知経路に
  深く介入する必要があり壊れやすく、`lib/check-updates.js`（UPDATE-002）とロジックが二重化する。却下。
- 案C（`check-updates.js` の `runNotify` に一本化）: 方針としては良いが、現状 `runNotify` は stderr 出力で
  TUI 起動中に混ぜると画面崩れ・UX 劣化のリスクがある。今回は見送り、通知機能は別途 first-party 側で検討。

codex 判断: 「B/C はやらず、A で upstream release notification を無効化。`runNotify` は今回 TUI に接続しない」
が最も事故が少ない。

### 実装方針（UPDATE-001 再修正と共通基盤）

**フックのファイル名判定**（symlink 解決有無どちらでも機能させる）:
- `path.basename(filename) === 'app.js'`
- かつ `filename.split(/[\\/]/).includes('.copilot-termux')`
- `--preserve-symlinks` 環境下では `current/app.js` のまま渡る可能性があるため、
  「filename と realpath のどちらでも `.copilot-termux` 配下なら OK」という形にし、
  実パス依存のみに寄せすぎない（codex 指摘）
- 内容パターンの一致件数チェック（UPDATE-001: 期待1件、UPDATE-003: 期待1件）は維持し、
  件数が合わない場合は無変更・`console.warn` のみ（upstream 変化検知、クラッシュさせない）

**追加の安全策（codex 提案・採用）**:
- パッチ処理は `patchAppJs(content)` のような単体関数に分離し、テスト可能にする
- UPDATE-001 と UPDATE-003 のパッチは同一 `_compile` フック内でまとめて適用する
- `Module._extensions['.js']` の二重ラップ防止（多重 require 対策）
- コメントは実際の対象ファイルである `app.js` を指すよう修正する（現状 `index.js` 記載は誤り）
- CJS の `Module._extensions['.js']` は ESM ロードには効かない前提を明記（現行起動経路では
  Node の CJS 互換ロードを経由するため有効 — 前提が崩れていないかは実装後のテストで確認する）

**Haiku 実装時の注意点（codex 指摘・そのまま実装指示に使う）**:
- `index.js` 条件を残してしまわないこと
- `current` リテラル依存を残してしまわないこと
- `filename.includes('.copilot-termux')` のような雑な部分一致だけで判定しないこと（パス区切りで
  分割した配列に対する完全一致を使う）
- UPDATE-003 で `owner:"github",repo:"copilot-cli"` の置換だけして、別の upstream 通知経路を
  見落とさないこと
- `runNotify` を今回 TUI 起動経路に直接呼ばないこと（stderr 汚染・画面崩れリスク）
- 置換件数チェックなしで `.replace()` しないこと
- `console.warn` を頻発させて TUI 出力を汚さないこと

**テスト観点（codex 指摘）**:
- fake `~/.copilot-termux/1.0.65/app.js`（symlink 経由でない実パス）で発火する
- fake `~/.copilot-termux/current/app.js`（symlink 経由）でも発火する
- `index.js` では発火しない
- `.copilot-termux` 配下でない `app.js` では発火しない
- UPDATE-001 対象文字列が1件なら置換、0件/2件なら無変更（`console.warn` のみ）
- UPDATE-003 の upstream 通知パターンが1件なら無効化、0件/2件なら無変更
- **実際に tgz を `npm install -g` してグローバルインストールした状態**で `copilot` を起動し、
  TUI の `/update` 表示・起動時バナーの両方を実機目視確認する
  （[[feedback_smoke_test_real_install.md]] の教訓：ソース直接実行の確認だけで済ませない）

---

## UPDATE-004: `/update` 実行時に表示される changelog が upstream 公式版のもの

**重要度**: Low
**影響バージョン**: 1.0.65-1（修正版: 次回リリース）
**発見日**: 2026-07-03（ユーザーが TUI 実機確認中に指摘）
**状態**: ✅ `registerHooks()`方式で修正実装済み・実機検証済み（2026-07-03、当初1.0.65 app.jsで検証。
同日、実際の1.0.68 app.jsに対しても`patchAppJsSource()`適用・UPDATE-001/003/004全パターン
1回ずつマッチを再確認済み。MANIFEST-002参照）。次回publishに含める。

### 症状

TUI で `/update` を実行すると、実際にインストールされる npm コマンド文字列は
UPDATE-001 修正により正しく `@bash0816/copilot-termux`（fork）を指すようになった。
しかし同時に表示される changelog（更新内容の説明文）は upstream 公式リポジトリ
（`github/copilot-cli`）の最新リリースノートのままで、fork 側の変更内容ではない。

### 原因（特定済み）

`~/.copilot-termux/1.0.65/app.js` を実際に調査して特定した。`/update` コマンドの
実行フロー内で upstream tag と現在バージョンを semver 比較し、upstream 側が新しくない場合
（fork は独自の npm バージョン管理をしているため、この比較では大抵「更新不要」と判定される）、
以下のように `/changelog` コマンドへフォールバックする:

```js
if(!D5t.default.gt(u,a))return k7.execute(t,[a]);
```

（`D5t`・`k7`・`u`・`a` は minify後の変数名でバージョンごとに変わる）

`k7`（`/changelog` コマンド）は `~/.copilot-termux/<version>/changelog.json` という
**upstreamが同梱する静的ファイル**（fork固有の変更ではなく upstream公式のリリースノート）を
読み込んで表示する。ネットワーク呼び出しではなく、upstream npm パッケージにバンドルされた
ローカルファイルが原因。UPDATE-003（`owner:"github",repo:"copilot-cli"` 由来のAPI呼び出し）とは
別の、完全にローカルな経路だった。

### 修正内容（`packages/copilot-termux/lib/platform-patch.js` の `patchAppJsSource()`）

UPDATE-001/003 と同じ `registerHooks()` 方式（正規表現パターンマッチ・件数チェック・
`console.warn` フォールバック）で3つ目のパッチとして実装。`k7.execute(t,[a])` の
戻り値契約（`{kind:"add-timeline-entry",entry:{type:"info",text:...}}`、実際のapp.jsコードを
調査して確認済み）を維持したまま、changelog本体を取得・表示する代わりに
fork向けの短いメッセージ（"No new updates. @bash0816/copilot-termux (Termux fork) is
already up to date."）に差し替える。

### 検証結果（2026-07-03）

- 実際の `~/.copilot-termux/1.0.65/app.js`（8,470,466 bytes）に対してパターン1件マッチ・
  パッチ適用を確認（パッチ後 8,470,455 bytes）
- パッチ後のソースが ESM として構文的に正しいことを確認
  （`node --check --input-type=module`）
- UPDATE-001・UPDATE-003 の既存パッチが引き続き正しく動作することを確認（無傷）
- `platform-patch.hook-verify.js` の既存19テスト全てPASS（回帰なし）

### 残作業

- ユーザーによる実機TUI確認（`/update` 実行時の表示文言）
- 次回 candidate publish（1.0.65-1 は既に publish 済みで再publish不可のため、
  バージョンバンプが必要）

---

## CI-001: `release-finalize.yml` の `release_notes` 入力がコマンドインジェクション脆弱

**重要度**: Medium（悪用条件は限定的だが設計として危険）
**影響ファイル**: `.github/workflows/release-finalize.yml`
**発見日**: 2026-07-03（1.0.65-1のGitHub Release作成を試みた際に実際に発生）

### 症状

`release-finalize.yml` は `workflow_dispatch` の `release_notes` 入力を

```yaml
run: |
  NOTES="${{ inputs.release_notes }}"
  gh release create "v${VERSION}" --notes "$NOTES" ...
```

のように `run:` ブロックへ直接 `${{ }}` 展開で埋め込んでいる。GitHub Actions はこの展開を
**シェルが解釈する前のテキスト置換**として行うため、`release_notes` にバッククォートや `$()`、
改行を含む複数行Markdown（コードブロック等、リリースノートとしてはごく普通の内容）を渡すと、
その内容がシェルコマンドとして実行されてしまう。

### 実際に発生した事故

1.0.65-1 のリリースノート（Markdownのコードブロック `npm install -g @bash0816/copilot-termux` 等を
含む）を `release_notes` 入力として `gh workflow run` 経由で渡したところ、ジョブログに

```
npm error code EBADPLATFORM
npm error notsup Unsupported platform for @bash0816/copilot-termux@1.0.65-1: wanted {"os":"android,linux","cpu":"arm64"} (current: {"os":"linux","cpu":"x64"})
```

が出力された。これは実際のワークフロー定義には存在しない `npm install` コマンドであり、
**私が渡したリリースノート本文（Install セクションのコードブロック）が実行時にシェルへ
そのまま注入され、GitHub Actionsランナー上で実際に実行されてしまった**ことを示している。
結果としてジョブは失敗し、リリースは作成されなかった。

### 影響

- `release_notes` に複雑な内容（コードブロック等）を渡すと確実に壊れる（今回のように失敗するだけで
  済むが、悪意ある入力であれば任意コマンド実行につながる。このジョブには
  `permissions: contents: write` があり `GH_TOKEN` も利用可能なため、リポジトリへの書き込み権限を
  持つコマンドが実行され得る）
- `workflow_dispatch` は誰でも起動できるわけではない（リポジトリへの書き込み権限が必要）ため
  実害の緊急度は高くないが、設計として修正すべき典型的な GitHub Actions script injection パターン

### 暫定対応（2026-07-03実施）

このワークフローは使わず、`gh release create --notes-file <file>` で直接 v1.0.65-1 のリリースを
作成した（安全、シェル展開を経由しない）。v1.0.63 のリリースも同様に手動作成されたとみられる
（`release-finalize.yml` を実際に使った形跡がジョブ履歴上ない）。

### 恒久対応（未実施・次回サイクル）

`release_notes` を `${{ }}` 展開で `run:` に埋め込まず、`env:` 経由で環境変数として渡し、
シェル側では `"$NOTES"` のように変数展開のみで参照する形に修正する
（`env: NOTES: ${{ inputs.release_notes }}` → `run: gh release create ... --notes "$NOTES"`）。
これは GitHub Actions 公式ドキュメントが推奨する script injection 対策の標準パターン。

---

## バグ優先度サマリー

| ID | 内容 | 重要度 | 修正前提 | 状態 |
|-----|------|--------|----------|------|
| AUTH-001 | free↔enterprise切り替えで認証失敗 | Critical | なし | ✅ 修正済み・3-step 実機確認済み |
| MODEL-001 | 権限外モデルが表示される | High | AUTH-001 | ✅ 修正済み・enterprise 実機確認済み |
| MODEL-002 | MCP経由の権限取得が不安定 | High | AUTH-001 | -p モード確認済み。TUI モード未確認 |
| UPDATE-001 | `/update`が`@github/copilot`を参照 | Medium | なし | ✅ `registerHooks()`方式で実装完了・実機検証済み（2026-07-02） |
| UPDATE-002 | `copilot update` が npm パッケージ更新に非対応 | High | なし | ✅ 修正済み（2026-07-02） |
| UPDATE-003 | 起動時通知バナーが upstream 公式のバージョンを参照 | Medium | なし | ✅ UPDATE-001と同じ`registerHooks()`フックで実装完了・実機検証済み（2026-07-02） |
| UPDATE-004 | `/update`実行時のchangelogがupstream公式版を表示 | Low | なし | ✅ `registerHooks()`方式で実装完了・実機検証済み（2026-07-03）。次回publishに含める |
| BUG-NEW-1 | Free TUI auto モードで 400 | High | MODEL-001 | 🔍 修正実装済み・TC-1 実機確認待ち |
| MANIFEST-001 | wrapper 1.0.65 が upstream 1.0.64 をダウンロードする | Medium | なし | ✅ 修正済み（commit `1097c77`、2026-06-29。ドキュメント更新漏れを2026-07-03是正） |
| MANIFEST-002 | Watch自動化がconfig/manifest.jsonを更新せず、実体は追従しない | High | なし | ✅ 手動修正済み（2026-07-03、下記参照） |
| CI-001 | release-finalize.ymlのrelease_notesがコマンドインジェクション脆弱 | Medium | なし | 🔜 未修正（暫定: `gh release create --notes-file`で回避済み） |
| UPDATE-005 | `/update`のchangelogがフォーク独自バージョンの実内容を反映しない（UPDATE-004固定文言の限界） | Low | v1.0.68のGitHub Release作成 | ✅ GitHub Releases API方式で実装（2周目設計）・Sonnet自己検証・Opus STEP8 Go判定済み（2026-07-03）。残: v1.0.68 Release作成・TUI実機目視確認・npm publish。詳細: `docs/update-changelog-plan.md` |
| TAB-001 | TUIでIssues/Pull requestsタブがグレーアウトする | - | なし | ✅ 調査完了・フォーク固有バグではない（upstream仕様）。下記参照 |

## MANIFEST-002: Watch自動化が`config/manifest.json`を更新しない（実体が追従しない）

**重要度**: High
**発見日**: 2026-07-03（ユーザーが「copilotのこのマシンに68入ってないじゃないか」と指摘し発覚）
**状態**: ✅ 手動修正済み（次回Watch実行分から要恒久対応、下記参照）

### 症状

`Copilot version watch`（commit `84756e9`）は upstream 1.0.68 を検知し、以下を自動更新した:
- `packages/copilot-termux/config/copilot-termux-release-manifest.json`（`copilot_version: "1.0.68"`、記録・ドキュメント用）
- `packages/copilot-termux/package.json`（`version: "1.0.68"`、ラッパー自体のバージョン表記）
- `config/napi-known-exports.json`（NAPI監査の既知エクスポート台帳）

しかし **`packages/copilot-termux/config/manifest.json`（`lib/setup.js`が実際に読む、upstream tarballのバージョン・integrityハッシュを保持するファイル）は更新されなかった**。この結果:

- npmラッパーの`package.json`は`1.0.68`と表示される
- しかし`copilot-termux setup`（＝グローバルインストール後に`copilot`コマンドが実際に使う本体をセットアップする処理）は`config/manifest.json`の`copilot.version`（`1.0.65`のまま）を見て動くため、**実際にダウンロード・実行されるupstream本体はいつまでも1.0.65のまま**
- `~/.copilot-termux/current`は`1.0.65`を指し続け、`copilot --version`も`1.0.65`を返す

「ラッパーのpackage.json versionが1.0.68」という見た目だけで「1.0.68が入っている」と判断すると誤り。[[feedback_wrapper_version_vs_runtime]]参照。

### 原因

`.github/workflows/copilot-version-watch.yml`のcommitステップが`git add`する対象ファイルリストに
`packages/copilot-termux/config/manifest.json`が含まれていない（napi-known-exports.json・
release-manifest.json・package.json・platform-patch.jsのみ）。加えて、このファイルの`integrity`
フィールドはnpm registryから取得したtarballのsha512ハッシュが必要で、Watch側にその取得・書き込み
ロジックがそもそも実装されていない。

### 今回の暫定対応（2026-07-03・手動）

1. `npm view @github/copilot-linuxmusl-arm64@1.0.68 dist.integrity` で正しいintegrityハッシュを取得
2. `packages/copilot-termux/config/manifest.json`の`copilot.version`を`1.0.68`、`integrity`を
   上記の値に手動更新（commit予定）
3. `npm pack` → `DISABLE_INSTALLATION_CHECKS=true npm install -g <tgz>` → `copilot-termux setup`
   を実行し、実際に`~/.copilot-termux/1.0.68`がダウンロード・展開されることを確認
4. `copilot --version` → `GitHub Copilot CLI 1.0.68.` を実機確認
5. `platform-patch.js`の`patchAppJsSource()`を実際の1.0.68 `app.js`に適用し、UPDATE-001/003/004の
   3パターンすべてが1回ずつマッチ・置換されること（`skipping patch`警告が出ないこと）を確認
6. `copilot -p "1+1は"` → 正常応答（クラッシュ・エラーなし）を確認

### 恒久対応（次サイクルで検討・今回スコープ外）

`copilot-version-watch.yml`のcommitステップに`config/manifest.json`の`copilot.version`/`integrity`
自動更新を追加する（npm registryのtarball integrityを取得するステップが必要）。STEP B/C
（`docs/watch-1068-automation-plan.md`）と合わせて次サイクルで着手する。

### 他プロジェクト(ClaudeCode-Termux-private)由来バグの横展開確認（2026-07-02）

ユーザーからの指摘で、`CluadeCode-Termux-private` issue #16・#7 と同種のバグが
copilot-termux にもないか確認した。**いずれも該当なし。**

- **issue #16**（`installTarget()` が `--prefix` なしで `npm install -g` を実行するため、
  `~/.local` 等の非標準 prefix 環境で実際に使われているバイナリが更新されない）
  → copilot-termux の `check-updates.js` は `__dirname` から prefix を動的導出し、
  `installVersion()` で常に `--prefix` を渡す実装に既になっている（本ファイル内
  UPDATE-002 の GPT-5.5 レビュー指摘1で「prefix 導出が2段ずれ」を修正済み）。
  再現条件（非標準 prefix 未対応）に当たらない。
- **issue #7**（レガシー typo パッケージ名 `@bash0816/cluade-code` が `installTarget()` に
  残ってしまい、canonical 名へ移行できない）
  → copilot-termux にはリネーム・typo の歴史がなく、`pkg.name` がそのまま
  正式名 `@bash0816/copilot-termux` のため該当しない。

## TAB-001: TUIでIssues/Pull requestsタブがグレーアウトする（調査完了・修正不要）

**重要度**: -（バグではない）
**発見日**: 2026-07-03（ユーザーが1.0.68 TUI実機テスト中に指摘）
**状態**: ✅ 調査完了。フォーク固有のバグではなく upstream の意図した仕様と判明。

### 症状

TUI のタブで「標準（Session）」と「Gists」しか選択できず、「Issues」「Pull requests」タブが
グレーアウトして選択できない。

### 原因（実 app.js 解析で特定済み、詳細は `docs/update-changelog-plan.md` 付録）

Issues / Pull requests タブは `showGitHubRepositoryTabs` が false の場合のみ `disabled:true` になる。
呼び出し元は一貫して `showGitHubRepositoryTabs: Er.isGitHubRepository` を渡しており、
`isGitHubRepository` は「カレントディレクトリが GitHub を remote に持つ git リポジトリの中にあるか」
で決まる（git root検出 → remote URL から GitHub の owner/repo をパースできれば true）。
Gists は disabled 対象の Set に含まれていないため常に有効。

### 対応方針

修正不要。`copilot` を GitHub remote 付きの git リポジトリ内（例: `Github-Copilot-Termux` の
clone 内）で起動すれば Issues / Pull requests タブが有効になるはず。次回リリースの
ブロッカーにはしない。

## 残作業

1. **TC-1 実機確認**: Free TUI で `modelsFilterToPicker:fallback` ログ確認・チャット送信テスト
2. **MODEL-002 TUI テスト**: TUI モードで `/login` + アカウント切り替えを実機確認（ユーザー作業）
3. **npm publish**: UPDATE-001/003 修正・ユーザーTUI目視確認完了（2026-07-03、UPDATE-004は既知の低優先度バグとして許容）。
   `npm-package.yml` を `publish=true` で trigger → `npm-publish` 環境でユーザー承認 → candidate 公開
   → 別マシン(glibc mode)確認 → 承認後 `retag_latest=true` で latest 昇格
4. **UPDATE-004**: changelog表示ロジックの箇所特定・修正は次回サイクルで対応

---

> **1.0.65 対応状況（2026-06-28）**:  
> AUTH-001・MODEL-001・UPDATE-001 修正済み。enterprise `-p`/TUI 動作確認済み。  
> BUG-NEW-1（Free auto 400）調査中。MODEL-002 TUI 確認待ち。
