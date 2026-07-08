# Known Bugs — 未解決バグ一覧

> **記録日**: 2026-06-27（最終更新: 2026-07-07）  
> **Opus レビュー**: 2026-06-27 実施済み  
> **状態**: AUTH-001 修正済み・enterprise 実機確認済み。UPDATE-001・UPDATE-003 は `registerHooks()` 方式で修正・実機検証済み（2026-07-03、ユーザーTUI目視確認済み）。UPDATE-004/005（changelog表示機能）は過剰実装と判断し完全撤去済み（2026-07-03、詳細下記）。UPDATE-006 は5回のTUI実機確認で原因特定不能につき断念・既知バグとして記録のみ（下記参照。上の一文は古い記述だったため訂正）。**npm latest は 1.0.68 として公開・GitHub Release済み（2026-07-03）**。MANIFEST-002 は2026-07-04 commit `d92e68d` で恒久対応済み。CI-001（release-finalize.yml のコマンドインジェクション）は未修正のまま残存。

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

### ✅ 2026-07-07: ユーザーがTUIモードのアカウント切り替えを実機確認

TC-5/TC-6(Enterprise↔Free切り替え、TUI)を実施しPass。/loginでの切り替え後も
モデル権限判定・チャット応答は正常。ただし切替直後のfooterのAIC(AI消費量)表示に
ついて疑問が浮上したため、AIC-001として本ファイル末尾に別途記録(バグ未確定)。

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

### 🔴 2026-07-06 追記: 上記の修正（2026-06-28実装）はその後別方式に置き換わった

本セクションの当初の解決策（`modelsFilterToPicker`に`policy.state=enabled`フォールバックを追加）は
2026-06-28時点のものだが、その後2026-06-29〜30の調査で、bionic libcのpthread ABIが
`runtime.node`のtokioランタイムと非互換であることが根本原因と判明。最終的に採用された解決策は
**glibc mode**（agy-termuxと同じ手法。glibc版Node.js + glibc版runtime.nodeを別途取得し、
glibc loader経由で起動）で、commit `651bde3`（1.0.65-2、2026-06-30）以降、現在のnpm latest（1.0.68）にも
継続して含まれる。詳細は `docs/free-auto-mode-analysis.md` 参照。

2026-07-06、この glibc mode 実装について初めてGPT-5.5の正式コードレビューを実施。
4件のBlocker（partial state fallback・setup atomic化・バージョン再検証・JSスタブ棚卸し）を
指摘され、うち3件（bin/copilot partial state検出、setup.js atomic化、glibc-nodeバージョン再検証）を
commit `27185d4`・`7b6c614`で修正しGoを取得。残る1件（JSスタブ棚卸し）は「実装変更不要、
glibc modeでもJSスタブを意図的に維持する設計」という結論（B案）で解消し、
`platform-patch.js`にコメントとして明記した（commit `e843a49`）。
`docs/SMOKE-TEST.md`のTC-1もglibc mode前提の確認項目に更新済み（commit `8d12ac0`）。

これらの修正はすべてnpm未公開のため、`packages/copilot-termux/package.json`のwrapperバージョンを
`1.0.68` → `1.0.68-1`に更新（commit `96acfcf`、upstream `@github/copilot`自体は1.0.68のまま据え置き）。

**現状（2026-07-06時点）**: コードレビュー・静的検証は完了。残る作業はTC-1（glibc mode起動確認込み）の
実機TUI確認のみ。それが完了すればcandidate publish（1.0.68-1）に進める状態。

### 🔴 2026-07-06 追記2: 実機スモークテストで新規バグを発見・修正（LD_PRELOAD継承）

このマシンで実際に`npm pack` → `npm install -g` → `copilot-termux setup`を実行したところ、
**GPT-5.5のコードレビューでも見落とされていた実行時バグ**を発見した:

`setup.js`の`setupGlibcNode()`内`verifyNodeBinary()`が`execFileSync`呼び出し時に環境変数を
明示的に指定しておらず、Termuxのデフォルトシェル環境にある`LD_PRELOAD=libtermux-exec-ld-preload.so`
（bionic向けexecフック）をそのまま継承していた。この状態でglibc loaderを実行すると
`error while loading shared libraries: .../glibc/lib/libc.so: invalid ELF header`で必ず失敗し、
**通常のターミナルから`copilot-termux setup`を実行すると常にsetupが失敗する**状態だった。

`bin/copilot`本体は起動時に`exec env LD_PRELOAD="" ...`と明示的にLD_PRELOADをクリアしていたが、
`setup.js`側にはこの対処が抜けていた。GPT-5.5に再レビューを依頼しGoを取得後、
`execFileSync`のoptionsに`env: { ...process.env, LD_PRELOAD: '' }`を追加して修正（commit `c570df2`）。

**修正後の実機確認結果（このマシンで実施）**:
- `npm pack` → `npm install -g ./bash0816-copilot-termux-1.0.68-1.tgz` でクリーンインストール ✅
- `copilot-termux setup` 実行 → `✓ glibc node ready` `✓ copilot 1.0.68 ready` で正常完了 ✅
- 旧`glibc-node`実ディレクトリ → `glibc-node-26.2.0`バージョン別ディレクトリ+symlinkへの
  マイグレーションを確認（`readlink`で実際にsymlink化されていることを確認）✅
- `runtime.node`・`cli-native.node`両方の存在を確認（partial state検出の修正が機能）✅
- `sh -x copilot --version`で`_GLIBC_READY=1`分岐（glibc mode起動）に入ることを確認 ✅
- `copilot -p "1+1は"` → 正常応答（`1+1 = 2 です`）。`Auto-mode unavailable`エラーは発生せず ✅
- TUI起動（`copilot`単体実行）→ クラッシュせず正常なANSI初期化シーケンスを出力 ✅
  （ただし非対話的な自動化環境のため、picker表示・チャット送信・応答の完全な目視確認は
  技術的に不可。expect/tmux等のptyエミュレートツールがこの環境に無いため）

**残作業**: 上記の通りコードレベルの実機確認は完了したが、**TUIの目視確認（picker表示・
実際のチャット応答）はユーザー本人による確認が必須**。ユーザーが検証実施予定（2026-07-06）。

### ✅ 2026-07-07: ユーザーによるTUI目視確認完了(TC-1〜TC-6全実施)

ユーザーがdocs/SMOKE-TEST.mdのTC-1〜TC-6を実機TUIで実施。結果: 全てPass。
- TC-1/TC-2(Free — Chat/Agent): picker表示・チャット応答とも正常
- TC-5/TC-6(アカウント切り替え Enterprise↔Free): 切替後の動作も正常
- -pモード・copilot update(UPDATE-007修正込み)も正常動作を確認
- 口頭要約のみで詳細コマンドログは未取得(G4レビューでは要約ベースで実施)

この結果によりBUG-NEW-1は実機確認レベルで完了。ただし派生の疑問点は
本ファイル末尾のAIC-001(未確認)として別途記録。

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

## UPDATE-004/005: フォーク独自の changelog 取得・表示機能の撤去

**重要度**: Low
**影響バージョン**: 1.0.68-1（撤去完了版）
**発見日・改訂**: 2026-07-03（ユーザーが TUI 実機確認中に指摘し方針転換）
**状態**: ✅ UPDATE-004/005 の実装を完全に撤去、upstream 本来のコードをそのまま実行させるよう修正（2026-07-03）。構文チェック・依存関係検証完了。

### 背景

UPDATE-005（6節で設計された GitHub Releases API 方式の changelog 表示機能）の実装後、ユーザーから以下を指摘された：
1. フォーク独自のリリースノート（Claude が執筆した文章）を表示する必要があるのか
2. upstream 本来の `/changelog` コマンド（静的 `changelog.json`）をそのまま実行するだけでは駄目なのか
3. 実装が複雑・ネットワーク依存・タイムアウト処理等、保守コストに見合うか

### 調査結果（2026-07-03）

- `~/.copilot-termux/<version>/changelog.json` は upstream が同梱する公式ファイル（バージョン番号をキーにした辞書、273バージョン分）
- `/changelog` コマンド（`nj.execute(t,[version])`）は引数の version キーに対応するエントリだけを表示する仕様
- upstream の本来の挙動（UPDATE-004 が上書きする前）: 更新判定（バンドルバージョン > registry 最新）が false の場合、`/changelog` で現在バージョンの公式リリースノートを表示
- このマシン（ローカル 1.0.68、npm latest 1.0.65-1）の状態で、UPDATE-004/005 のコードは実際に「現在の 1.0.68 のリリースノートを GitHub API で取得・表示」しようとしていた
- しかしユーザーの指摘「今動いているバージョンの変更内容が見たい」は、単純に upstream 本来の `changelog.json` 参照（UPDATE-004 が上書きする前のコード）で既に満たされていた

### 決定

「changelog 取得は upstream 公式に委ねる」方針に転換。UPDATE-004（`/changelog` フォールバック置換）と UPDATE-005（GitHub Releases API 実装）を**完全に削除**し、upstream 本来のコードをそのまま実行させる。

### 修正内容（2026-07-03 実施済み）

1. `lib/platform-patch.js`
   - UPDATE-005 ブロック全体（`FALLBACK_ENTRY`, `withTimeout`, `toDisplayVersion`, `truncateReleaseNotes`, `buildForkUpdateMessage`, `getForkUpdateMessage`, `globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__` 登録）を削除
   - `patchAppJsSource()` 内の `CHANGELOG_FALLBACK_PATTERN` とその置換処理を削除
   - UPDATE-001（npm install 置換）・UPDATE-003（通知バナー無効化）は変更なし（別の独立した正規表現）

2. `lib/check-updates.js`
   - UPDATE-005 専用の `fetchReleaseNotes()` 関数と定数（`RELEASE_OWNER`, `RELEASE_REPO`, `RELEASE_NOTES_MAX_BYTES`）を削除
   - `module.exports` から `fetchReleaseNotes` を除去
   - `resolveTarget`, `currentVersion`, `fetchVersionManifest` は UPDATE-002/003（`copilot update` / 起動時通知）で使用中のため削除しない

3. `packages/copilot-termux/package.json`
   - `copilotTermuxChangelog` フィールド（6節で追加されたもの）は既に削除済み

### 効果

- `/update` 実行時、更新なし判定なら upstream 本来の `/changelog`（＝動いている upstream バイナリの version に対応する公式 changelog.json のエントリ）がそのまま表示される
- フォーク独自の文章・GitHub API 呼び出し・タイムアウト処理は一切なくなる
- 保守コスト削減・複雑性低減

### 検証（2026-07-03）

- `node --check` で両ファイルの構文: OK
- `patchAppJsSource()` が UPDATE-001/003 のパターンのみマッチ・置換：確認済み
- `platform-patch.hook-verify.js` に、changelog fallback 分岐（upstream本来の
  `if(!X.gt(u,a))return Y.execute(t,[a])` 相当）が無改変で残ること・
  `__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__` が混入しないことを確認する回帰テストを
  2件追加（codex STEP2レビューの必須指摘）。**21 PASS, 0 FAIL** で全件確認済み
  （Sonnet実行、2026-07-03）
- 残作業: 実グローバルインストールでのスモークテスト・ユーザーTUI実機確認・npm publish

### バージョン表記の訂正（2026-07-03）

UPDATE-005 実装時に `package.json` の `version` を `1.0.68` → `1.0.68-1` にバンプしていたが、
UPDATE-004/005 を完全撤去した結果、baseline（`1.0.68` プレーン版、commit `84756e9`）との差分は
ゼロになった（`platform-patch.js` は無差分、`check-updates.js` も `fetchVersionManifest` への
分割・追加 export が未使用のまま残っていただけと判明したため baseline に戻した）。
fork独自の変更が実質的に存在しない以上 `-1` リビジョンを名乗る理由がないため、
`version` を `1.0.68`（サフィックスなし）に戻した。ユーザー指摘により発覚。

---

## UPDATE-006: `/update` の latest 判定元をフォーク自身の npm dist-tag に差し替える

**重要度**: Low
**発見日**: 2026-07-03
**状態**: 🔴 実装済みだがTUI実機確認で5回失敗・原因特定不能・修正断念（2026-07-04）。1.0.68はこのバグを含んだままnpm publish進行。

### 確定した要求（ユーザーが複数回言い直した最終形。これ以外の解釈をしない）

`/update` 実行時に表示すべきなのは、**「フォーク自身のlatestバージョン」に対応する「upstream公式の
changelog」**。両方の条件を同時に満たす必要がある：

1. **「latest」の基準はフォーク自身**（`@bash0816/copilot-termux` の npm latest/candidate タグ）。
   upstream (`github/copilot-cli`) の生のGitHub latestではない。フォークのバージョンには
   `1.0.68-1` のような **upstreamには存在しないフォーク独自リビジョンsuffix** が付くことがあるため、
   これを取り除いて base upstream バージョン（例: `1.0.68-1` → `1.0.68`）にしてから参照する。
2. **表示するchangelog本文は upstream 公式のもの**。フォーク独自に書いた文章（Claudeが書いた
   リリースノート等）を表示してはならない。フォーク自身のGitHub repo
   (`bash0816/Github-Copilot-Termux`) の Release本文を使うのも誤り（＝結局フォークが書いた文章）。

つまり：**「latestの判定元」はフォーク、「changelogの内容」はupstream公式** という組み合わせが
唯一の正解。片方だけ満たす実装（過去3回とも）はすべてユーザーに拒否された。

### 過去の試行と失敗理由（同じ間違いを繰り返さないための記録）

| # | 試行内容 | 結果 | 却下理由 |
|---|---------|------|---------|
| 1 | UPDATE-004: `/changelog`フォールバック文字列を単純置換 | 撤去済み | 検証不十分、要件を満たさず |
| 2 | UPDATE-005: GitHub Releases APIでフォーク独自リリースノート(Claude執筆)を取得・表示 | 撤去済み | 「誰が書いたの、公式なの？」と拒否。フォーク独自文章を公式のように見せた |
| 3 (今回) | 「upstreamは既にGitHub Releases APIで最新changelogを表示している、バグではない」と結論 | 誤り、撤回 | **「latest」をupstream基準にすり替えていた**。ユーザーが最初から要求していたのは「フォーク自身のlatest」。詭弁と指摘された |
| 4 (今回) | `owner:"github",repo:"copilot-cli"`を`owner:"bash0816",repo:"Github-Copilot-Termux"`に4箇所とも置換（`patchAppJsSource()`に追加→即座に revert 済み、コードは残っていない） | 誤り、revert済み | 「latestの判定元」だけでなく「changelog本文の取得先」までフォーク自身のrepoに変えてしまった。表示されるのが再びフォーク独自(Claude執筆)のRelease本文になり、UPDATE-005と同じ過ちを繰り返した |

### 正しいと考えられる設計（未実装・次の担当者が実装する前に再検証すること）

app.js の実コード（`nj`=`/changelog`本体, `ALt`=`/update`本体, いずれも1.0.68時点で確認済み）:

```
ALt.execute: a=xp()(現在バージョン, upstream内蔵値, suffixなし固定)
             c=await DO(l,s)  // fetchLatestRelease: GET /repos/github/copilot-cli/releases/latest
             u=c.tag_name     // ← ここが upstream の生latest。フォークのlatestではない
             if(!gt(u,a)) return nj.execute(t,[a])  // 更新なし→現在バージョンのchangelog
             ...              // 更新あり→Amr(t,u)→CLt(t,u)→nj.execute(t,[u])
nj.execute:  f=引数の version
             h=ローカルchangelog.jsonの該当キー。あればそれを表示（upstream公式データ、正しい）
             なければ fetchReleaseByTag(f,authInfo) で
             GET /repos/github/copilot-cli/releases/tags/{tag} から upstream公式body を取得・表示
             （これも upstream公式データ、正しい。owner/repoは絶対に変えてはいけない）
```

**変えるべきはただ一箇所**: `u`（"latest"として扱われる値）の決定方法。
`DO()`（`api.github.com/repos/github/copilot-cli/releases/latest`）の代わりに、
「`@bash0816/copilot-termux` の npm dist-tag latest を取得し、`-N`サフィックスを除去した
base upstreamバージョン」を`u`として使うようにする。それ以外（`nj.execute`・
`fetchReleaseByTag`・そのowner/repo・changelog.jsonルックアップ）は一切変更しない。

**実装上の未解決の技術的課題（次の担当者が最初に検証すべきこと）**:
- `DO()`の呼び出し箇所は`owner:"github",repo:"copilot-cli"`という**文字列パラメータの置換だけでは
  実現できない**。「npm registryに問い合わせてsuffixを除去する」という**新しい非同期ロジックの注入**
  が必要（UPDATE-001/003のような単純な文字列置換パターンでは足りない）
- 注入方法の候補:
  (a) `globalThis.fetch`のオーバーライドで`releases/latest`へのリクエストだけ横取りし、
      npm registry問い合わせ結果を合成したResponseを返す（codex STEP2でConditional Go判定済み、
      ただし「octokitのHTTPクライアントが実際に`globalThis.fetch`を使っているか」が実機未検証。
      1.0.68のapp.js内でoctokit-request周辺に`fetch(`の直接呼び出しが見当たらず、
      `node-fetch`相当のバンドル済みモジュールを使っている疑いがある。**これを最初に確定させること**）
  (b) `gR("GET /repos/{owner}/{repo}/releases/latest",{...})`の呼び出し式自体を、
      soure-text正規表現で「fork latest解決関数の呼び出し」に置換する（文字列パースがより複雑）
  - どちらの方式でも、**`releases/tags/{tag}`（`fetchReleaseByTag`側）のowner/repoには絶対に
    手を出さない**（ここを変えるとUPDATE-005と同じ過ちになる）
- suffix除去後の値と`gt(u,a)`の比較で意図しない結果にならないか要確認
  （`a=xp()`は常にsuffixなしの値なので、素朴には問題ないと推測されるが未検証）

### 副次的な問題（今回のセッションで発生・要対応）

`bash0816/Github-Copilot-Termux` repoのGitHub Release `v1.0.68-1`
（https://github.com/bash0816/Github-Copilot-Termux/releases/tag/v1.0.68-1）の本文が、
**既に撤去済みのUPDATE-004/005を「修正内容」として説明したまま**になっている。
このリリースは今回のセッション中に作成されたものだが、その後UPDATE-004/005を完全撤去したため、
内容が実態と矛盾している。訂正または削除が必要（未対応、ユーザー確認待ち）。

### 現在のgit状態（2026-07-03、引き継ぎ時点）

コミット未実施（ローカル作業ツリーの変更のみ、`git status --short`で確認可能）:
- `docs/KNOWN-BUGS.md`: 変更あり（本ドキュメント含む）
- `packages/copilot-termux/lib/check-updates.js`: UPDATE-005由来の未使用リファクタ
  （`fetchVersionManifest`分割等）をbaseline(`84756e9`)相当に復元済み
- `packages/copilot-termux/package.json`: `version`を`1.0.68-1`→`1.0.68`に修正済み
  （UPDATE-004/005撤去後、baselineとの差分がゼロになったため`-1`suffixを名乗る理由がなくなった）
- `packages/copilot-termux/lib/platform-patch.js`: **無差分**（今回試みたowner/repo置換パッチは
  即座にrevertし、baselineのまま）
- 直前のコミット`6f6514b`（UPDATE-004/005完全撤去）は**ローカルコミットのみ、push未実施**

### 対応方針

未修正のまま次回サイクル（Sonnet 4.6引き継ぎ）へ持ち越す。実装着手前に必ず:
1. 「確定した要求」セクションの2条件（latestはフォーク基準、内容はupstream公式）を再確認する
2. 「実装上の未解決の技術的課題」の検証（octokitがglobalThis.fetchを使うか）を最初に行う
3. STEP1/2設計レビュー（codex）を経てから実装する
4. `v1.0.68-1`のGitHub Release本文の訂正/削除をユーザーと相談する

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

### 恒久対応（実施済み・2026-07-05 commit `16839be`）

`version` / `release_notes` を `${{ }}` 展開で `run:` に埋め込む代わりに、`env:` 経由で
`VERSION` / `NOTES_INPUT` として環境変数に渡し、シェル側では `"$VERSION"` / `"$NOTES_INPUT"`
のように変数参照のみで扱う形に修正した。あわせて不要だった `pull-requests: write` 権限も削除。

GPT-5.5によるG1〜G4レビュー（設計→実装プラン→diff→検証）すべてGoを確認済み。G4では
`gh`をスタブ化したシェルレベルの再現テストで、修正前コード（`eval`で`${{ }}`直接展開を再現）は
`$(touch ...)`ペイロードが実際にシェルコマンドとして評価される（`Permission denied`エラーが
証拠）のに対し、修正後コードでは同じペイロードが`gh`への引数文字列としてしか渡らないことを確認した。

これは GitHub Actions 公式ドキュメントが推奨する script injection 対策の標準パターン。

**未実施**: 実際の `workflow_dispatch` 実行による動作確認（本物の GitHub Release を作ってしまう
副作用があるため見送り）。次回の本番リリース finalize 実行時に動作確認する。

---

## バグ優先度サマリー

| ID | 内容 | 重要度 | 修正前提 | 状態 |
|-----|------|--------|----------|------|
| AUTH-001 | free↔enterprise切り替えで認証失敗 | Critical | なし | ✅ 修正済み・3-step 実機確認済み |
| MODEL-001 | 権限外モデルが表示される | High | AUTH-001 | ✅ 修正済み・enterprise 実機確認済み |
| MODEL-002 | MCP経由の権限取得が不安定 | High | AUTH-001 | ✅ -p モード・TUI モードとも実機確認済み（2026-07-07、TC-5/TC-6 Pass） |
| UPDATE-001 | `/update`が`@github/copilot`を参照 | Medium | なし | ✅ `registerHooks()`方式で実装完了・実機検証済み（2026-07-02） |
| UPDATE-002 | `copilot update` が npm パッケージ更新に非対応 | High | なし | ✅ 修正済み（2026-07-02） |
| UPDATE-003 | 起動時通知バナーが upstream 公式のバージョンを参照 | Medium | なし | ✅ UPDATE-001と同じ`registerHooks()`フックで実装完了・実機検証済み（2026-07-02） |
| BUG-NEW-1 | Free TUI auto モードで 400 | High | MODEL-001 | ✅ glibc mode実装済み(1.0.65-2〜)・GPT-5.5コードレビュー完了(2026-07-06、Blocker4件中3件修正・1件は設計明文化で解消)。wrapperバージョンを1.0.68-1に更新(commit `96acfcf`)。実機スモークテストでLD_PRELOAD継承バグを発見・修正(commit `c570df2`)、setup成功・glibc mode起動・`-p`応答を確認済み。✅ TUI目視確認完了（2026-07-07、TC-1〜TC-6全Pass） |
| AIC-001 | アカウント切替後のfooter AIC表示が期待と逆に見える | 未定 | AUTH-001 | 🔍 未確認・要追加調査（2026-07-07発見、詳細は本ファイル末尾参照）。publishブロッカーにはしない |
| MANIFEST-001 | wrapper 1.0.65 が upstream 1.0.64 をダウンロードする | Medium | なし | ✅ 修正済み（commit `1097c77`、2026-06-29。ドキュメント更新漏れを2026-07-03是正） |
| MANIFEST-002 | Watch自動化がconfig/manifest.jsonを更新せず、実体は追従しない | High | なし | ✅ 恒久対応済み（2026-07-04 commit `d92e68d`、下記参照） |
| CI-001 | release-finalize.ymlのrelease_notesがコマンドインジェクション脆弱 | Medium | なし | ✅ 恒久修正済み（2026-07-05 commit `16839be`、下記参照） |
| UPDATE-004/005 | `/update`のchangelog表示をフォーク独自の複雑な実装で実現 | Low | なし | ✅ 過剰実装と判定し完全撤去。upstream本来のコードに戻す修正完了（2026-07-03）。構文チェック・依存関係検証済み |
| UPDATE-006 | `/update`が「フォーク自身のlatest」の公式changelogを表示できない | Low | なし | 🔴 TUI実機確認で5回失敗・原因特定不能・修正断念。既知バグとして記録のみ。1.0.68はこのバグを含んだままnpm publish進行 |
| TAB-001 | TUIでIssues/Pull requestsタブがグレーアウトする | - | なし | ✅ 調査完了・フォーク固有バグではない（upstream仕様）。下記参照 |
| MODEL-MENU-001 | Freeプランなのに`/model`メニューに有料モデル(gpt-5.5等)がリスト表示される | - | なし | ✅ 調査完了・フォーク固有バグではない（upstream仕様、G4相当レビューGPT-5.5 Go）。実機TUI目視確認は未実施。下記参照 |

## MANIFEST-002: Watch自動化が`config/manifest.json`を更新しない（実体が追従しない）

**重要度**: High
**発見日**: 2026-07-03（ユーザーが「copilotのこのマシンに68入ってないじゃないか」と指摘し発覚）
**状態**: ✅ 恒久対応済み（2026-07-04 commit `d92e68d`。手動修正で発覚した問題に加え、Watch自動化そのものを修正した）

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

### 恒久対応（実施済み・2026-07-04 commit `d92e68d`）

`copilot-version-watch.yml`のcommitステップに`config/manifest.json`の`copilot.version`/`integrity`
自動更新ロジックを追加した:
- `npm view @github/copilot-linuxmusl-arm64@${NEW_VERSION} dist.integrity` でintegrityを取得し、
  取得失敗時はWARNINGスキップではなく`exit 1`で確実に失敗させる
- `npm view`出力を`| head -1`でフィルタし改行混入を防止
- `git add`の対象ファイルリストに`packages/copilot-termux/config/manifest.json`を追加
- 同commitで`npm-package.yml`のpublishチェックも`latest_candidate_version`から`copilot_version`に変更、
  `node -e`内のシェル変数展開を`process.env`経由に統一（インジェクション対策）

上記により、次回Watch実行分から`config/manifest.json`が自動追従する。旧記載「次サイクルで検討・スコープ外」は
2026-07-05のドキュメント実態確認で古いと判明したため訂正。

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

## MODEL-MENU-001: Freeプランなのに`/model`メニューに有料モデルがリスト表示される（調査完了・修正不要・実機目視確認は未実施）

**重要度**: -（バグではないと判定）
**発見日**: 2026-07-08（ユーザーが1.0.69 TUIで`/model`メニューを開いた際に指摘。footerに
`Your Copilot Free plan currently includes only Auto.`と出ているのに、その下の選択肢に
`gpt-5.5` `gpt-5.4` `gpt-5.3-codex` `gpt-5.4-mini` `gpt-5-mini` `claude-sonnet-5` `claude-sonnet-4.6`
が並んでいるのはおかしい、との指摘）
**状態**: ✅ 調査完了。フォーク固有のバグではなく upstream（GitHub公式CLI本体）の意図した仕様と判明。
GPT-5.5によるG4相当の検証レビューでもGo（ブロッカーなし）。

### 調査の経緯

最初にapp.js（1.0.69）を静的解析しただけで「upstream仕様だから問題ない」と結論づけたが、
ユーザーから「無料アカウントと有料アカウントは別物なのに、無料アカウントに有料アカウント向けの
情報が出ること自体がおかしい」と再検証を求められ、実機ログ・実際のAPIレスポンス確認・
GPT-5.5セカンドオピニオンまで行って裏付けを取った。

### 実機ログで確認した事実

Freeアカウント（`copilot_internal/user` APIで `access_type=free_limited_copilot`,
`copilot_plan=individual` と確認済み）で `copilot -p "1+1"` を実行し、
`~/.copilot/logs/` のログを確認した:

```
Using Copilot API at https://api.individual.githubcopilot.com
Listed 33 models
```

→ **GitHub公式サーバー（`api.individual.githubcopilot.com`）が、Freeアカウントに対しても
33モデル分のメタデータをそのまま返している**ことを実機ログで確認。fork側が有料モデル情報を
合成・追加しているのではない。

取得できたモデル例（gpt-5-mini、Autoの裏側で実際に使われたモデル）:
```json
"model_picker_enabled": false,
"policy": { "state": "enabled", "terms": "..." }
```

### app.js（upstream本体）の該当ロジック

`/model`メニューは以下の4種を全て一覧に混ぜる設計（`Xe=[...Ve,...Nt,...gt,...ut,...Ee]`）:
- `available`（利用可能。Freeなら実質Autoのみ）
- `policyBlocked`（組織ポリシーでブロック）→ フォーカスすると
  "This model is disabled by your organization's policy." と表示
- `subscriptionUnavailable`（プラン対象外）→ フォーカスすると
  "Your {プラン名} plan doesn't include this model." と表示
- `customModels`

選択確定コールバックにはガード節があり、`availability!=="available"`なモデルは
Enterを押しても選択確定処理が呼ばれない:
```js
ve=(0,eo.useCallback)(De=>{let Ue=H.get(De.value);!Ue||Ue.availability!=="available"||a(Ue)},[H,a])
```
（`if (!Ue) return; if (Ue.availability !== "available") return; a(Ue);` と等価）

つまり「利用不可なモデルもあえて一覧に見せて、選ぶと理由を表示する」意図的なアップセルUIであり、
選んでも実際にモデルは切り替わらない。

### GPT-5.5によるセカンドオピニオン（2026-07-08、G4相当レビュー）

**Go**（ブロッカーなし）。選択確定ガード節の解釈をNode上で再現実行して独自検証し、
`subscription-unavailable`/`policy-blocked`/`undefined`いずれでも`a(Ue)`が未呼び出しであることを
確認済み。fork側(`platform-patch.js`)が有料モデル候補を合成している形跡もなしと判定。
唯一の留保: 「セキュリティ・プライバシー上まったく問題ない」と断定するには33モデル全件の
生レスポンス本文（`reasonLabel`・`policy.terms`等に組織固有情報が含まれないか）までは
確認していないため、そこは限定的な表現にとどめるべきとの指摘。

### 対応方針

修正不要。ただし以下は未実施:
- 実機TUIでの目視確認（該当行がグレーアウト表示になること、フォーカス時に理由文言が出ること、
  Enter後にモデルが変わらないこと）。コード解析・独立検証では確実視されているが、
  実際の画面での確認はまだ行っていない。ユーザーが別途実機で再検証予定（2026-07-08）。
- 33モデル全件の生JSONレスポンス本文の確認（機密情報混入の有無）は未実施。

## 残作業

1. **TC-1 実機確認**: Free TUI で `modelsFilterToPicker:fallback` ログ確認・チャット送信テスト
2. **MODEL-002 TUI テスト**: TUI モードで `/login` + アカウント切り替えを実機確認（ユーザー作業）
3. **npm publish（1.0.68）**: UPDATE-001/003・UPDATE-004/005撤去・UPDATE-006（全件コードレビュー済み・スモークテスト済み）完了後、
   `npm-package.yml` を `publish=true` で trigger → `npm-publish` 環境でユーザー承認 → candidate 公開
   → 別マシン(glibc mode)確認 → 承認後 `retag_latest=true` で latest 昇格
4. ~~**UPDATE-006 TUI目視確認**~~: 5回試行・原因特定不能につき断念。既知バグとして記録のみ。npm publishは3番の完了をもって進める。

---

## UPDATE-007: check-updates.jsのバージョン比較がfork独自パッチをnpm latestへ自動ダウングレードする

**重要度**: High
**影響バージョン**: 1.0.65-1・1.0.68（修正は 1.0.68-1 以降）
**発見日**: 2026-07-06（ユーザーがTUI実機検証中に判明）
**状態**: ✅ 修正完了・実機検証済み（2026-07-06）

### 症状

ユーザーが TUI 実機検証中（内部バージョン 1.0.68-1）に `copilot update` を実行したところ、
npm 上の古い latest（無印 1.0.68）に自動ダウングレードされ、検証中のビルドが失われた。

```
$ copilot --version
GitHub Copilot CLI 1.0.68.  # 正しくは 1.0.68-1 のはず

$ copilot update
Already on latest version: 1.0.68
# 実際には 1.0.68 < 1.0.68-1 であり、1.0.68 は旧版
```

### 根本原因

`lib/check-updates.js` の `compareVersions()` 関数が、一般 semver 慣習
（`-N` は正式版より前のプレリリース識別子で常に格下）のままで比較していた。
一方、このフォークの実運用は「`-N` は正式版リリース後に追加した fork 独自パッチのリビジョン番号」
という逆の意味であり、**前提が逆転していた**。

例：
- 一般 semver では: `1.0.68-1 < 1.0.68`（prerelease は unstable）
- このフォークの運用: `1.0.68 < 1.0.68-1`（suffix なし = revision 0、`-1` = revision 1）

### G1/G2 レビュー結果

**GPT-5.5 による複数回のイテレーション経て最終 Go 判定取得済み**（2026-07-06）
- G1 設計レビュー: Go
- G2 実装プランレビュー: Go

### 修正内容

`lib/check-updates.js` の `compareVersions()` 関数内、prerelease 比較部分（45-66 行目）を以下に置換：

```js
  // このフォークの `-N` サフィックスは一般semverの「正式版より前のプレリリース」ではなく、
  // 「正式版リリース後に追加したfork独自パッチのリビジョン番号」を意味する。
  // suffixなし = revision 0、`-N` = revision N として扱い、Nが大きいほど新しいとみなす。
  // （例: 1.0.68 < 1.0.68-1 < 1.0.68-2）
  // parseVer前提: N は数字のみ（本ファイル冒頭コメントの前提を踏襲）。
  const ra = pa.pre === null ? 0 : Number(pa.pre);
  const rb = pb.pre === null ? 0 : Number(pb.pre);
  return ra - rb;
```

コメント更新: ファイル冒頭（24 行目・34-35 行目付近）の「prerelease」表現を
「fork revision の意味である」ことが分かるよう修正。

### テスト結果

`scripts/check-updates.test.js` にて以下 7 ケースを実装・実行・全 PASS 確認（2026-07-06）：

- `compareVersions("1.0.68", "1.0.68-1") < 0` ✅ （1.0.68 < 1.0.68-1）
- `compareVersions("1.0.68-1", "1.0.68-2") < 0` ✅ （1.0.68-1 < 1.0.68-2）
- `compareVersions("1.0.68-1", "1.0.68-1") === 0` ✅ （等価）
- `compareVersions("1.0.65-1", "1.0.68") < 0` ✅ （1.0.65-1 < 1.0.68）
- `compareVersions("1.0.69", "1.0.68-9") > 0` ✅ （1.0.69 > 1.0.68-9）
- `compareVersions("1.0.68-10", "1.0.68-2") > 0` ✅ （2 桁 revision 番号の確認）
- `compareVersions("1.0.68", "1.0.68") === 0` ✅ （無印版の等価）

テスト実行コマンド：`node --test scripts/check-updates.test.js` → ℹ pass 8、ℹ fail 0

### 実機検証結果（2026-07-06）

**環境**: Termux bionic mode  
**registry 状態**: latest=1.0.68、candidate=1.0.65-1、previous_stable=1.0.63

1. `npm pack` → `npm install -g` で修正版 1.0.68-1 をインストール
2. `copilot --version` → バイナリは 1.0.68（upstream）だが、wrapper は 1.0.68-1
3. `copilot update` 実行：
   - 出力: `Already on latest version: 1.0.68-1`
   - npm install コマンド: 実行されない（正しく「更新不要」と判定）
   - exit code: 0
   - version は変わっていない（正しく現状維持）

**修正確認**: `compareVersions("1.0.68-1", "1.0.68") > 0` の比較結果により、
1.0.68-1 が npm latest の 1.0.68 より新しいと正しく認識。ダウングレード発生せず。

### 既存方針の維持

修正により影響を受ける既存ロジック（`resolveTarget()` 関数の 103-114 行目）：

```js
  // current が prerelease または current > latest の場合のみ candidate も確認
  if (isPrerelease(currentVersion) || compareVersions(currentVersion, latestVer) > 0) {
    try {
      const candidateVer = await fetchVersion('candidate');
      // latest と candidate のうちより新しい方を bestVer とする
      if (compareVersions(candidateVer, bestVer) > 0) {
        bestVer = candidateVer;
      }
    } catch {
      // candidate タグ取得失敗は無視
    }
  }
```

修正前後の動作変化：
- **修正前**: `isPrerelease("1.0.68-1")` = true なので candidate も確認し、
  candidate（1.0.65-1）と latest（1.0.68）を比較して新しい latest を採用
  （但し compareVersions バグにより 1.0.68 < 1.0.68-1 の認識ずれ）
- **修正後**: `isPrerelease("1.0.68-1")` = true なので同じく candidate を確認し、
  `compareVersions("1.0.65-1", "1.0.68") < 0` により latest > candidate のため
  best は latest（1.0.68）で、current（1.0.68-1）> latest（1.0.68）なので
  targetVer = null（更新不要）と判定。**既存方針「stable ユーザーを candidate に上げない」は変わらず。**

---

> **1.0.65 対応状況（2026-06-28）**:  
> AUTH-001・MODEL-001・UPDATE-001 修正済み。enterprise `-p`/TUI 動作確認済み。  
> BUG-NEW-1（Free auto 400）調査中。MODEL-002 TUI 確認待ち。

---

## AIC-001: アカウント切り替え後のfooter「AIC used」表示が期待と逆に見える（未確認・要追加調査）

**重要度**: 未定（バグかどうか未確定）
**発見日**: 2026-07-07（ユーザーがTC-5/TC-6実機確認中に気づき指摘）

### 症状

TUIでEnterprise→Freeへアカウント切り替え後、footerに`Session: 4.09 AIC used`のような
AIC（AI消費量）表示が出た。Free→Enterprise方向の切り替えでは逆にFree側は非表示・
Enterprise側で表示、という「有料アカウントだけ表示される」想定と一致する挙動だったため、
Enterprise→Free方向だけ逆に見える点が気になった、との指摘。

### ここまでの調査（静的確認のみ・実機ネットワークキャプチャ未実施）

- footerの表示条件は upstream本体（`lib/copilot/app.js`）にある正規ロジック：
  ```js
  xm = Kr.status==="LoggedIn" && Cc(Kr.authInfo.copilotUser)
  function Cc(t){ return t?.token_based_billing===!0 }
  ```
  これ自体はGitHub公式コードで、copilot-termux側が書いたものではない。
- `copilotUser`は`platform-patch.js`の`authManagerSwitchToAuth`/`authManagerLoginUser`が
  アカウント切り替えの都度`_buildAuthInfo()`で再取得しており、見た目上は両方向で対称。
- `platform-patch.js`には`authManagerRefreshCopilotUser`という、常に`null`を返すだけの
  スタブが存在するが、`app.js`本体からこの関数名で呼ばれている形跡がgrep上見つからず、
  実際に呼ばれているか（＝デッドコードで無害か、それとも本当は呼ばれていて再取得漏れの
  原因になっているか）は未確認。
- 「free/有料(Enterprise含む)で表示が変わるべき」という業務ルール自体は認識合わせ済みだが、
  今回テストで使った「free」アカウントが実際に無償のGitHub Copilot Freeプランなのか、
  それとも有償のCopilot Individual/Proプラン（token-based billingが有効になり得る）なのか、
  アカウント自体の実際のプラン種別を未確認のため、表示が「バグ」なのか「そのアカウントの
  正しい課金状態を反映しているだけ」なのかを切り分けられていない。

### 対応方針

いったんバグ疑いとして記録のみ。以下がわかれば切り分け可能：
1. テストに使った「free」アカウントの実際のプラン種別（GitHub側の課金設定画面で確認）
2. `authManagerRefreshCopilotUser`が実際に呼ばれているかのトレース（デバッグログ追加等）
3. 切り替え直後の`/copilot_internal/user`レスポンス実体（`token_based_billing`の値）を
   Enterprise→Free切り替え時に実際にキャプチャして確認

上記が揃うまでnpm publishのブロッカーにはしない（ユーザー判断、2026-07-07）。
