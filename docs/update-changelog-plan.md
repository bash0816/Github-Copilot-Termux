# UPDATE-005: `/update` の changelog をフォーク独自バージョンの実内容に差し替える

**発端**: ユーザーが 1.0.68 サイクルの TUI 実機テストから戻り、UPDATE-004（"No new updates.
already up to date." という固定文言）について「これだと何がアップデートされたかわからない」と指摘。
npm の `latest` タグでバージョンチェックし、そのバージョンの changelog を表示するよう修正依頼。

**状態**: STEP2 codex(gpt-5.5)レビュー2周目 **Go**（2026-07-03）→ Haikuに実装委任 →
Sonnetが独立に自己検証完了（2026-07-03）→ **追加修正**（下記「表示バージョンの`-N`サフィックス除去」参照）
→ Sonnet再検証完了・グローバルインストール反映済み。**残作業: TUI実機目視確認（ユーザー）・npm publish**。

### 追加修正: 表示バージョンから`-N`サフィックスを除去（2026-07-03）

ユーザー指摘: npm registry上の実バージョン文字列（例: `"1.0.65-1"`）の末尾`-1`は
**このフォーク独自のリビジョン番号サフィックスであり、upstream公式のバージョン表記には存在しない**。
changelogメッセージの表示上はこの独自サフィックスを見せず、`v1.0.65`のように公式表記に
揃えてほしいとの指示。

**対応**: `platform-patch.js`に`toDisplayVersion(v)`ヘルパーを追加
（`v.replace(/-\d+$/, '')`、`check-updates.js`の既存コメントに明記されている
「フォークのprerelease表記は`x.y.z-N`（Nは数字のみ）」という規約に準拠した正規表現）。
`buildForkUpdateMessage()`内でメッセージ本文を組み立てる瞬間だけ`targetVer`/`currentVersion`に
適用し、**バージョン比較ロジック（`check-updates.js`の`resolveTarget`/`compareVersions`/
`parseVer`）には一切手を触れていない**（比較は生の`-N`付き文字列のまま行う必要があるため）。

Sonnetが実機で再検証: `toDisplayVersion("1.0.65-1")`→`"1.0.65"`、`resolveTarget()`は
引き続き比較用に生の値（今回は`null`=更新なし、ローカル1.0.68 > registry 1.0.65-1のため）を
返すことを確認。`node --check`構文OK・既存19テスト再実行でPASS・`npm pack`→グローバル
再インストールしてdev repoとの完全一致・`copilot --version`回帰なしまで確認済み。

### 実装・検証結果（2026-07-03、Sonnet独立検証）

- `check-updates.js`: `fetchVersionManifest()`新設、`fetchVersion()`をその薄いラッパーに変更、
  `resolveTarget`/`currentVersion`/`fetchVersionManifest`をexport追加。既存`runUpdate`/`runNotify`
  ロジックは無変更。
- `platform-patch.js`: `withTimeout()`（`finally`で`clearTimeout`済み、レビュー指摘反映）、
  `buildForkUpdateMessage()`、`getForkUpdateMessage()`を追加。app.js注入テキストに`await`なし・
  `typeof`ガード使用（レビュー指摘反映）。
- `package.json`: `copilotTermuxChangelog.highlights`フィールド追加（今回のdevサイクルの
  変更点を記載。次回リリース時にRELEASES.mdの内容と合わせて要更新）。
- **実機`app.js`（`~/.copilot-termux/1.0.68/app.js`、8,399,014 bytes）に対して`patchAppJsSource()`を
  実行**: UPDATE-001/003/004-005すべて1件ずつマッチ・`console.warn`一切なし・パッチ後サイズ
  8,399,127 bytes。パッチ後ソースを`node --check`で構文検証 → **SYNTAX OK**（ESMとして正しい）。
- **`globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__()`を実際に4パターンで実行検証**:
  1. 実ネットワーク・実npm registry（`fetchVersionManifest`モックなし）→ ローカル(1.0.68) >
     registry latest(1.0.65-1) のため「already up to date」の固定文言を正しく返す
  2. `resolveTarget`をモックして「更新あり・highlights付き」→ highlights付きメッセージを正しく生成
  3. 「更新あり・`copilotTermuxChangelog`フィールドなし」→ 詳細なしの更新案内のみ（設計通り）
  4. 「`resolveTarget`自体が例外を投げる（DNS失敗相当）」→ `console.warn`ログ出力の上、
     既存の固定文言に正しくフォールバック（クラッシュなし）
- 既存の`platform-patch.hook-verify.js`（19項目・UPDATE-001/003のE2Eテスト含む）を再実行 →
  **19 PASS, 0 FAIL**。既存パッチに回帰なし。
- 未実施（実装完了の条件ではないが記録必須）: 全体8秒タイムアウトの実測確認（意図的にスキップ、
  ロジックレビューで妥当性確認済み）。

### 実グローバルインストールでのスモークテスト（2026-07-03、Sonnet実施）

ユーザーから「修正したアプリはこのマシンにインストール済みか」「スモークテストしたか」と
質問され、確認したところ**この時点ではまだ未インストールだった**（直前まではソースファイルへの
直接`require()`によるロジック検証のみで、[[feedback_smoke_test_real_install.md]]が警告する
「実グローバルインストール経由での確認」ができていなかった）。その場で以下を実施：

1. `cd packages/copilot-termux && npm pack` → `bash0816-copilot-termux-1.0.68.tgz` 生成
2. `DISABLE_INSTALLATION_CHECKS=true npm install -g <tgz>` でこの端末のグローバル
   `@bash0816/copilot-termux` を今回の修正版に置き換え
3. インストール済み `lib/platform-patch.js`・`lib/check-updates.js` を dev repo と `diff` し
   **完全一致**（IDENTICAL）を確認
4. 実コマンド `copilot --version` → `GitHub Copilot CLI 1.0.68.`、exit 0、
   `console.warn`（パッチ未適用の警告）なし
5. 実コマンド `copilot -p "say ok"` → 正常応答、exit 0（既存機能への回帰なし）
6. 使用後、dev repo 直下に生成された tgz ファイルは削除済み（作業ディレクトリを汚さないため）

**まだ実施できていないもの（対話操作が必要なためユーザー作業）**:
- TUI（Inkベースの対話画面）を実際に起動して `/update` スラッシュコマンドを実行し、
  UPDATE-005 のメッセージが画面に表示されることの目視確認。`copilot --version` /
  `copilot -p` は非対話コマンドのため今回 Sonnet が直接実行・確認できたが、`/update` は
  TUI 内でのキー入力を伴うため、[[feedback_smoke_test_real_install.md]] の前例と同様に
  ユーザーによる実機確認が必要。
- この端末の npm `latest` タグは `1.0.65-1` のままで、dev repo のバージョンは `1.0.68`
  （`1.0.68 > 1.0.65-1`）のため、**現状ではTUIで`/update`を実行しても「更新あり・
  highlights付き」パスではなく「already up to date」の固定文言パスが表示される**
  （ローカルの方がnpm registryより進んでいるため、これは正しい・意図した動作）。
  highlights付きの表示を目視確認するには、次回リリースでバージョンを上げて実際に
  `candidate`/`latest` へpublishした後、それより古いバージョンから`/update`を実行する必要がある。
  今回の「実機確認」は主に「クラッシュしないこと」「フォールバック文言が正しく出ること」の確認が
  目的になる。

### codexレビュー1周目の指摘（改訂前の設計に対して）

1. **High（設計根本の問題）**: `lib/changelog.json` をnpmパッケージにバンドルする方式は、
   **インストール済みの古いパッケージには「まだ存在しない未来バージョンの changelog」を
   含められない**。ユーザーが `1.0.68` を使っていて `1.0.69` が公開された場合、`1.0.68` に
   同梱された JSON は当然 `1.0.69` のエントリを持ちようがない。「更新時に実際の変更内容を表示する」
   という要件の核心部分が機能しない設計ミス。
   → **npm registry の target version 自体のメタデータから取得する方式に変更**（3.3節参照）。
2. **High**: `return await globalThis.X()` という `await` 注入は、将来 upstream ビルドで
   囲む関数が非 async 化した場合に**構文エラーで起動不能**という重すぎる壊れ方をする。
   → **`await` を注入せず、`return (typeof ...==="function"?...():{fallback})` 形式に変更**
   （enclosing function が async ならPromiseは自動でchainされ正しく動作する。非asyncになっても
   構文エラーにはならず、既存パッチと同じ「悪くても表示が変になるだけ」の劣化に留まる）。
3. **Medium**: `resolveTarget()` の待ち時間は条件次第で最大10秒（latest 5s + candidate 5s）。
   changelog取得の追加リクエストも含めるとさらに伸びる → 全体に上限タイムアウトを設ける。
4. **Medium**: `globalThis.X ? X() : fallback` は同名globalが truthy 非関数に汚染された場合
   TypeErrorになる → `typeof X === "function"` に変更。
5. `entry.highlights` が配列でない壊れたJSONでも落ちないよう `Array.isArray()` チェックを追加。

以下の3節は上記指摘を反映した改訂版。

---

## 1. 現状の問題

`platform-patch.js` の `patchAppJsSource()` にある UPDATE-004 パッチは、`/update` 実行時に
到達する「アップデート不要」分岐を **常に同じ固定文言**に差し替えている:

```js
'if(!$1)return {kind:"add-timeline-entry",entry:{type:"info",text:"No new updates. @bash0816/copilot-termux (Termux fork) is already up to date."}}'
```

これは UPDATE-001 修正（npm installコマンドの参照先修正）の副産物であり、**フォーク自体に
実際に新しいバージョンがあるかどうかを一切チェックしていない**。そのため:
- フォークに本当に新バージョンがあっても「already up to date」と表示されてしまう
- 「何がアップデートされたか」という情報が一切出ない

## 2. 実機調査で判明した事実（1.0.68 の実 app.js を直接解析）

`~/.copilot-termux/1.0.68/app.js`（8,399,024 bytes）を Python で直接検索し、該当箇所の
完全なコンテキストを確認した。

```js
ALt = {
  name: Uye,
  aliases: ["/upgrade"],
  help: "Update the CLI to the latest version",
  args: [{ type: "choice", choices: ["prerelease"] }],
  execute: async (t, e) => {
    let n = e[0] === "prerelease",
        r = Tx();
    t.autoUpdate?.promise && await t.autoUpdate.promise;
    let o = t.autoUpdate?.getResult();
    if (!n && r && o?.result === "success") return vLt(t, o);
    let s = await JE(t.authManager),
        a = xp(),                         // a = 現在バンドルされている upstream バイナリのバージョン（例: "1.0.68"）
        l = n ? "prerelease" : await Tmr(t);
    r && t.session.addTimelineEntry({ type: "info", text: "Checking GitHub for the latest release..." });
    let c = await DO(l, s);               // upstream (github/copilot-cli) の GitHub API 呼び出し
    if ("error" in c) return TLt(`Failed to check for updates: ${String(c.error)}`);
    let u = c.tag_name;                   // upstream の最新タグ
    if (!ELt.default.gt(u, a)) return nj.execute(t, [a]);   // ← UPDATE-004 が差し替えている箇所
    if (r) { ... }
    return Amr(t, u);
  }
}
```

**重要な確認事項**:
1. `execute` は **`async` アロー関数**。`return` 位置で `await` が構文的に使える
   （UPDATE-001 の教訓＝「動くはずという推測でSTEP2を通過させない」を踏まえ、実際のソースで確認済み）。
2. `a`（`xp()`）は upstream バイナリ自体のバージョン（`~/.copilot-termux/<version>/package.json`
   の version）であり、**フォーク自身の npm パッケージバージョン（`@bash0816/copilot-termux` の
   version、例: `1.0.65-1`）とは別物**。フォークユーザーの `a` は常に upstream の最新版に
   ほぼ一致するため、`ELt.default.gt(u,a)`（upstream tag > 現在の upstream バージョン）は
   ほぼ常に false になり、この分岐（"already up to date" 相当）がフォークユーザーには
   ほぼ毎回到達する。これが UPDATE-004 が「ほぼ常に固定文言を返す」動作になっていた理由。
3. `nj.execute(t,[a])` は `/changelog` コマンドの実行で、**upstream 同梱の静的
   `changelog.json`**（フォーク非依存）を表示する契約
   （`{kind:"add-timeline-entry",entry:{type:"info",text:...}}`、既存 UPDATE-004 調査で確認済み）。

## 3. 設計方針（改訂版・codexレビュー1周目の指摘を反映）

### 3.1 全体方針

この分岐を、**フォーク自身の npm レジストリの `latest` タグとインストール済みバージョンを比較し、
更新があれば target version 自体の changelog 本文を表示、なければ既存の固定文言（現状維持）を返す**
処理に差し替える。

- バージョン比較・npm registry 問い合わせは **`lib/check-updates.js` の既存ロジックを再利用**する
  （`resolveTarget()` は既に `latest`/`candidate` タグの取得・semver 比較・5秒タイムアウトを
  実装済み。UPDATE-002 で codex レビュー済み・スモークテスト済みの実装をそのまま流用し、
  ロジックの二重化を避ける）。
  - `check-updates.js` の `module.exports` に `resolveTarget` / `currentVersion` /
    `fetchVersionManifest`（新規、下記）を追加する（現状は `runUpdate`/`runNotify` のみ）。
- **changelog 本文はローカルバンドル JSON ではなく、npm registry から target version 自身の
  メタデータとして取得する**（codexレビュー指摘★Highを受けての変更）。
  - 理由: インストール済みの「今動いているパッケージ」に同梱した JSON は、その公開時点より
    **未来のバージョンの changelog を原理的に持てない**。ユーザーが `1.0.68` を使っていて
    `1.0.69` が公開された場合、`1.0.68` 同梱の JSON は `1.0.69` のエントリを持ちようがなく、
    「更新時に実際の変更内容を表示する」という要件の核心が満たせない。
  - 新方式: 各バージョンを `npm publish` する際、そのバージョンの `package.json` に
    **`copilotTermuxChangelog`** という独自フィールド（`{ "highlights": string[] }`）を含める。
    npm registry の `GET /<pkg>/<tag-or-version>`（`check-updates.js` の `fetchVersion` が
    既に叩いているのと同じエンドポイント）は、その version の package.json 相当の内容を
    そのまま返す（`dist`/`_id` 等が追加される以外、独自トップレベルフィールドは保持される）。
    つまり **target version 自身が「自分の changelog」を運び、fetch 時点で常に正しい内容が
    取得できる**（GitHub Release APIのprivate repo認証問題・追加のレート制限依存も回避できる）。
  - `lib/changelog.json` のようなバンドルファイルは作らない。`package.json` の `"files"`
    ホワイトリスト変更も不要（package.json 自体は常にレジストリに含まれるため）。
  - 運用: 新バージョンリリース時、`RELEASES.md` を書くのと同じタイミングで
    `packages/copilot-termux/package.json` の `copilotTermuxChangelog.highlights` を
    更新する（release checklist に追記が必要）。

### 3.2 `check-updates.js` 側の変更

既存の `fetchVersion(tag)` はレジストリ応答から `.version` だけを取り出している。
これを**内部で使う低レベル関数 `fetchVersionManifest(tag)`（フルJSONを返す）に一本化**し、
`fetchVersion` はその薄いラッパーにする（ロジック二重化を避ける・既存動作は完全に変更なし）。

```js
function fetchVersionManifest(tag) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(tag)}`;
    const req = https.get(url, { timeout: 5000 }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function fetchVersion(tag) {
  return fetchVersionManifest(tag).then(m => m.version);
}
```

`module.exports` を以下に変更（既存 `runUpdate`/`runNotify` のロジックは一切変更しない）:
```js
module.exports = { runUpdate, runNotify, resolveTarget, currentVersion, fetchVersionManifest };
```

### 3.3 `platform-patch.js` 側の実装

`patchAppJsSource()` 内に UPDATE-005 として 4 つ目のパッチを追加する（既存 UPDATE-001/003/004 と
同じ registerHooks 経由・正規表現1件マッチ限定・`console.warn` フォールバックのパターンを踏襲）。

**正規表現**（UPDATE-004 と同一のパターンを流用、キャプチャは `$1` のみで変更なし）:
```js
const CHANGELOG_FALLBACK_PATTERN = /if\(\!([a-zA-Z0-9_$]+\.default\.gt\([a-zA-Z0-9_$]+,[a-zA-Z0-9_$]+\))\)return [a-zA-Z0-9_$]+\.execute\([a-zA-Z0-9_$]+,\[[a-zA-Z0-9_$]+\]\)/g;
```

**置換後**（★codex指摘反映: `await` を注入しない。enclosing functionがasyncならPromiseは
自動でchainされ正しく動作し、将来非async化しても構文エラーにはならず「表示が変になるだけ」の
劣化に留まる。globalガードも `typeof` に変更）:
```js
'if(!$1)return (typeof globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__==="function"?globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__():{kind:"add-timeline-entry",entry:{type:"info",text:"No new updates. @bash0816/copilot-termux (Termux fork) is already up to date."}})'
```

**`globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__` の実装**（`platform-patch.js` 内、
`registerHooks` 登録より前で定義。ここは自前の CommonJS コードなので `await` を自由に使える
＝app.js への注入テキストの中とは別レイヤーであり、codexの★High指摘2の対象外）:
```js
const FALLBACK_ENTRY = { kind: 'add-timeline-entry', entry: { type: 'info',
  text: 'No new updates. @bash0816/copilot-termux (Termux fork) is already up to date.' } };

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('overall timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function buildForkUpdateMessage() {
  const { resolveTarget, currentVersion, fetchVersionManifest } = require('./check-updates.js');
  const targetVer = await resolveTarget();
  if (!targetVer) return FALLBACK_ENTRY;

  let highlights = [];
  try {
    const manifest = await fetchVersionManifest(targetVer);
    if (manifest && Array.isArray(manifest.copilotTermuxChangelog?.highlights)) {
      highlights = manifest.copilotTermuxChangelog.highlights;
    }
  } catch (_) {
    // changelog本文の取得失敗は致命的ではない。詳細なしで更新案内のみ表示する。
  }

  const body = `@bash0816/copilot-termux v${targetVer} available (current: v${currentVersion})\n\n` +
    (highlights.length ? highlights.map(h => `- ${h}`).join('\n') + '\n\n' : '') +
    'Run: npm install -g @bash0816/copilot-termux';
  return { kind: 'add-timeline-entry', entry: { type: 'info', text: body } };
}

async function getForkUpdateMessage() {
  try {
    // resolveTarget最大10秒(latest+candidate) + changelog取得5秒を見込み、全体上限を設ける
    return await withTimeout(buildForkUpdateMessage(), 8000);
  } catch (e) {
    console.warn('[copilot-termux] UPDATE-005: fork update check failed, falling back:', e && e.message);
    return FALLBACK_ENTRY;
  }
}

if (typeof globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__ !== 'function') {
  globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__ = getForkUpdateMessage;
}
```

**安全策のポイント**:
1. ネットワーク失敗・タイムアウト・JSON parse失敗など、あらゆる例外で必ず既存の固定文言に
   フォールバックする（`/update` が例外でクラッシュ・無反応になることは絶対に避ける）。
2. registry の manifest に `copilotTermuxChangelog` フィールドが無い（旧バージョン・
   リリース時の記載漏れ）場合でも「アップデートはある」という事実だけは伝え、
   インストールコマンドを案内する（詳細説明が無いだけで機能は落とさない）。
3. `check-updates.js` の `resolveTarget()` を `require()` で読み込む形にし、バージョン比較・
   npm fetch ロジックを二重実装しない（UPDATE-002 で確立済みのコードをそのまま信頼する）。
4. app.js へ注入するテキストには `await` を含めない。`getForkUpdateMessage()` はPromiseを
   返す関数であり、enclosing function（`execute: async (t,e)=>{...}`）が async である限り
   `return` されたPromiseは自動的にchainされて正しく動作する。将来 upstream が非async化しても
   構文エラーにはならず、既存パッチと同じ「表示が想定と違うだけ」の劣化に留まる。
5. 全体タイムアウト（8秒）を `platform-patch.js` 側で独自に設け、`resolveTarget()` の
   最大待ち時間（latest 5s + candidate 5s = 最大10秒）と changelog fetch の追加待ちが
   積み重なって `/update` が極端に長く固まることを防ぐ。

## 4. スコープ外・保留事項

- `copilotTermuxChangelog.highlights` の `RELEASES.md` からの自動生成は今回スコープ外。
  リリース時に手動で `package.json` に記載する運用とする。
- 日本語版 changelog 文言は今回スコープ外（TUI 表示は英語で統一。既存の固定文言・TUI全体が
  英語のため）。日本語の詳細は引き続き `RELEASES.md` 側で提供する。
- CLI サブコマンド `copilot update`（UPDATE-002）・起動時通知バナー（UPDATE-003）は今回変更しない。
  変更するのは `/update` 実行時の「アップデート不要 → changelog 表示」分岐（UPDATE-004 の延長）のみ。
- **注意**: この設計は「次にリリースする版（例: 1.0.68 の次）」以降で `copilotTermuxChangelog`
  フィールドを付けて publish しない限り効果を発揮しない。旧バージョンの manifest には遡って
  フィールドを追加できない（npm registry は publish 済みバージョンの再アップロード不可）ため、
  「今動いているバージョンより新しいバージョンが、そのフィールド付きで公開されて初めて」
  詳細な highlights が出る。それまでは 3.3 の「フィールド無し」フォールバック
  （更新案内のみ・詳細なし）が表示される。ユーザーに周知が必要な運用上の注意点。

## 5. テスト観点（実装時にそのまま使う）

- `resolveTarget()` が新バージョンを返し、そのバージョンの registry manifest に
  `copilotTermuxChangelog.highlights`（配列）があるケース → highlights 付きメッセージが返る
- 同上だが `copilotTermuxChangelog` フィールドが無い/`highlights` が配列でないケース →
  詳細なしの更新案内メッセージが返る（クラッシュしない）
- `resolveTarget()` が `null`（最新）を返すケース → 既存の固定文言と完全一致する
- npm registry 到達不能（タイムアウト・DNS失敗等、`resolveTarget()` 自体が reject）→
  固定文言にフォールバックし例外を投げない
- `fetchVersionManifest()` は成功するが JSON 構造が壊れている（`copilotTermuxChangelog` が
  文字列等）ケースでも `/update` 全体がクラッシュしない
- 全体タイムアウト（8秒）が正しく効き、ネットワークが極端に遅い場合でも `/update` が
  無限に固まらず固定文言にフォールバックする
- 実際にビルドした `app.js` に対して `patchAppJsSource()` を適用し、置換後のソースが
  `node --check --input-type=module` で構文エラーにならないことを確認
- 置換後コードに `await` を含まないことをコード上で確認（codex指摘★High2の再発防止）
  （UPDATE-004 の既存テスト手順を踏襲）
- **実際にグローバルインストールした状態で TUI の `/update` を目視確認**する
  （[[feedback_smoke_test_real_install.md]] の教訓。ソース直接実行の確認だけで済ませない）

---

## 6. 設計転換（2026-07-03 二周目・ユーザー指摘によるUPDATE-005再設計、実装前）

**発端**: ユーザーがこのマシンで実機確認中、「/update」の結果が固定文言
（"No new updates...already up to date."）のみでchangelog本文が一切出ないことに対し、
「今なら1.0.65のchangelogが表示されないといけない」「(npm registryに)無いなら仕方ないが、
普通は履歴で残っているものだよね」と指摘。上記1〜5節の設計（npm registryの
`copilotTermuxChangelog`カスタムフィールド方式）は**まだ実装・検証段階で一度もnpm publish
していない**ため、破棄・作り直しが可能な状態だった。

### 調査結果（事実確認）

1. npm registry `@bash0816/copilot-termux@1.0.65-1` の manifest には
   `copilotTermuxChangelog` フィールドが**存在しない**
   （`curl https://registry.npmjs.org/@bash0816/copilot-termux/1.0.65-1` で確認済み）。
   これは UPDATE-005 実装（package.json へのフィールド追加）より前に publish された
   バージョンであり、npm は publish 済みバージョンのメタデータを事後変更できないため、
   原理的に持ちようがない。4節「スコープ外・保留事項」に明記していた制約
   （「今動いているバージョンより新しいバージョンが、そのフィールド付きで公開されて
   初めて」効果を発揮する）が、まさに今のマシンの状態でそのまま顕在化していた。
2. 一方 **GitHub Releases には `v1.0.65-1`・`v1.0.63` の実際のリリースノートが
   既に存在する**（`gh release list --repo bash0816/Github-Copilot-Termux` で確認）。
   運用上、npm publish のたびに `gh release create` でリリースノートを作成済み
   （[[progress_copilot_termux_1065.md]] 参照、1.0.65-1本番リリース時に作成）。
3. リポジトリ `bash0816/Github-Copilot-Termux` は **Public**
   （`gh repo view --json visibility` → `"PUBLIC"`）。GitHub REST API
   (`GET /repos/.../releases/tags/{tag}`) は**無認証で200が返る**ことを確認した
   （`curl -o /dev/null -w "%{http_code}"` で実測）。3.1節にあった「GitHub Release APIの
   private repo認証問題」という懸念は**事実誤認**だったと判明（このリポジトリはprivateではない）。

### 新方針

changelog本文の取得元を「npm registryのカスタムフィールド」から
**「GitHub Releases API」**に変更する。

- 理由: GitHub Releasesは既存の運用（リリースごとに `gh release create` で作成）で
  過去バージョン分もすでに存在する。npm registry方式が抱えていた「publish時点より
  未来のバージョンにしか効かない」という制約が解消される。
- publicリポジトリのため認証不要。未認証レート制限（60回/hour/IP）は `/update` という
  低頻度な手動コマンドの用途には十分。

### 設計変更点

1. changelog取得先を `fetchVersionManifest()`（npm registry）から
   GitHub Releases API `https://api.github.com/repos/bash0816/Github-Copilot-Termux/releases/tags/v{version}`
   に変更する。`resolveTarget()`/`compareVersions()`/`currentVersion` 等の
   **バージョン比較ロジックは一切変更しない**（3.3節の既存方針を継続）。
2. **表示ロジックの転換**: 旧設計は「更新がある時だけchangelog表示、なければ
   固定文言のみ（changelogなし）」だった。新設計は
   **「更新の有無に関わらず、該当バージョン（更新ありなら target version、
   なければ current version）のリリースノートを表示する」**に変更する。
   ユーザーの要望（「今動いているバージョンでも何が変わったか分かるように
   してほしい」）に応える。
3. `packages/copilot-termux/package.json` の `copilotTermuxChangelog` フィールドは
   不要になるため削除する（GitHub Releasesが単一の情報源になり、
   package.json手動更新とのリリース時二重管理を避ける）。
4. release notes 本文はMarkdownで長文になりうる（実例: v1.0.65-1は約15行）。
   TUIのタイムラインentryにそのまま出すと見づらい可能性がある。表示形式
   （全文表示か先頭N行/N文字でtruncateするか）は次のcodexレビューで確認する。
5. 既存の安全策は維持する: ネットワーク失敗・タイムアウト・404時は既存の固定文言に
   フォールバック、8秒全体タイムアウト、app.js注入テキストに`await`を含めない
   `typeof`ガード方式（2節・3.3節の既存指摘の再発防止をそのまま踏襲）。
6. バージョン→タグ名のマッピング: `v${version}`（例: `1.0.65-1` → `v1.0.65-1`、
   実際のGitHub Releaseタグ名と一致することを確認済み）。既存の`toDisplayVersion()`
   による`-N`サフィックス除去はメッセージ見出し部分の表示にのみ適用し、
   GitHub APIへのタグ問い合わせ自体には生のバージョン文字列（`-N`付き）を使う。
7. 該当バージョンのGitHub Releaseがまだ作成されていない場合
   （リリース漏れ・作成前）は404になるため、既存の固定文言にフォールバックする。
   運用上のリスク: 今後リリースのたびに `gh release create` を忘れると
   changelogが出なくなる → リリースチェックリストに明記が必要。

### 未確定・次のcodexレビューで確認する点

- レート制限・キャッシュの要否（`runNotify`には既存の24hキャッシュがあるが、
  `/update`実行時のchangelog取得は都度APIコールでよいか、それともキャッシュすべきか）
- release notes本文の表示形式（truncateの要否・文字数上限・Markdown記法をそのまま
  出すか簡略化するか）
- 現在のバージョン（`1.0.68`）はまだGitHub Release未作成 → 次回リリース作業で
  `gh release create` を先に行うか、`/update`側のフォールバック（404時は固定文言）で
  当面しのぐか

### codex(gpt-5.5) STEP2レビュー結果（2026-07-03・6節設計に対して）

**判定: Conditional Go**（実際にGitHub APIを叩いて実測した上での判定。
`v1.0.65-1`は200・`bodyLen=890`・23行、`v1.0.68`は**404**であることを確認済み）

GitHub Releases APIへの転換自体は妥当（npm manifest方式は既存publish済み版に
後付けできず、「今動いている版の履歴も見たい」という要件を満たせないため）。

**Blocker（実装時に必ず満たす）**:
1. **「更新なしでもcurrent versionのリリースノートを表示する」を実装で徹底する**。
   1周目実装（`platform-patch.js`の`buildForkUpdateMessage`）は
   `resolveTarget()`が`null`の場合に即`FALLBACK_ENTRY`を返す作りだったため、
   このまま流用すると新要件（更新の有無に関わらず該当バージョンを表示）を
   再び満たさない。`const targetVer = await resolveTarget(); const noteVer = targetVer || currentVersion;`
   のように表示対象バージョンを明示的に分岐すること。
2. **`v1.0.68`のGitHub Releaseを次回リリース前に作成する**。今回の指摘の動機
   （「今動いている版のchangelogが出るべき」）を実機確認するには
   `v1.0.68`のReleaseが存在している必要がある（現状404）。

**Non-blocker（推奨・そのまま採用）**:
- レート制限は問題なし（未認証60/hour、`/update`は低頻度手動操作のため）。
  ただし同一TUI内での連打に備え、プロセス内メモリキャッシュ
  `version -> {body, checkedAt}`を5〜10分保持するのは実装コストが低ければ推奨
  （永続キャッシュは不要、release notes修正の反映が遅れるため）
- 表示形式: 「見出し + body先頭20〜30行または2000〜3000文字、超過時は`...`と
  release URLを付記」で実装する
- **SSRF対策**: リクエストURLは
  `https://api.github.com/repos/bash0816/Github-Copilot-Termux/releases/tags/v${encodeURIComponent(version)}`
  のようにowner/repo/hostを**コード内に固定**し、`package.json.repository`や
  環境変数から動的に取得しないこと
- **レスポンスサイズ上限**: 現状の`fetchVersionManifest()`はbodyを無制限に
  連結している。GitHub Releases APIのレスポンスにも64KBまたは128KB程度の
  上限を設け、超過時はabort・固定文言にフォールバックする
  （自分たちが管理するデータのため重大リスクではないが、堅牢性として実施）
- HTTP 403/429/5xx・JSON parse失敗・`body`が文字列でない場合も、すべて
  既存の固定文言フォールバックで対応してよい
- 8秒全体タイムアウト・app.js注入に`await`不使用の既存方針は維持で妥当。
  ただし`resolveTarget()`自体が最大10秒（latest 5s + candidate 5s）
  かかりうるため、8秒タイムアウトは「candidate確認中に打ち切られうる」
  仕様であることをコードコメントに明記する

**このレビューを受けての結論**: 6節の設計方針（GitHub Releases API転換・
常時表示ロジック）のまま実装に進んでよい。ただしBlocker 2点
（表示分岐の実装徹底・v1.0.68 Release作成）を実装/リリース作業に必ず含める。

## 7. 実装完了・Opus STEP8レビュー結果（2026-07-03）

**実装**: Haiku（Agent tool model="haiku"）に委任。`check-updates.js`に`fetchReleaseNotes(version)`
新設（GitHub Releases API、owner/repo/hostハードコード、64KBサイズ上限、既存`resolveTarget`等は無変更）、
`platform-patch.js`の`buildForkUpdateMessage()`をGitHub Releases API方式に全面書き換え
（`noteVer = targetVer || currentVersion`でBlocker①を実装、`truncateReleaseNotes()`新設）、
`package.json`の`copilotTermuxChangelog`フィールド削除。

**Sonnet独立検証**: `node --check`両ファイルOK・既存19テストPASS（回帰なし）・実ネットワークで
`fetchReleaseNotes('1.0.65-1')`成功(body 892字)/`fetchReleaseNotes('1.0.68')`が期待通りHTTP 404・
`buildForkUpdateMessage()`を6パターン（更新あり×notes成功/404、更新なし×notes成功/404、
resolveTarget例外、40行超のtruncate）モックテストし全て設計通りの出力を確認。

**Opus STEP8コーディングレビュー結果: Go**。実際の`~/.copilot-termux/1.0.68/app.js`を解析し
「execute:asyncのreturn位置でPromiseを返しても安全」という最重要前提を実バンドルで裏取り済み。
既存パッチ(UPDATE-001/003/004)・`isTargetCopilotAppJsUrl`・`registerHooks`への回帰なし。
SSRF対策・64KB上限・User-Agentヘッダーとも問題なし。Blocker①実装も確認済み。

**Non-blocker指摘のうち2件を反映**:
1. `releaseUrl`をGitHub APIの`html_url`優先（手組みURL手段はフォールバックのみ）に変更
2. `FALLBACK_ENTRY`を`Object.freeze()`（共有参照の意図しないmutation防止）

反映後も`node --check`OK・既存19テストPASS・6パターン再検証で回帰なしを確認済み。

**残作業**:
1. **v1.0.68のGitHub Release作成**（STEP2 Blocker②、現状404実測済み）→ npm publish前に対応
2. 実グローバルインストールでのスモークテスト（[[feedback_smoke_test_real_install.md]]の教訓）
3. ユーザーによるTUI実機目視確認（`/update`実行時の表示）
4. OK後、確立済みのnpm publishフロー（candidate→ユーザー承認→別マシンglibc確認→latest昇格）へ

---

## 8. 方針転換: UPDATE-004/005 を完全撤去（2026-07-03 三周目・ユーザー指摘）

**発端**: ユーザーが実機確認から戻り、UPDATE-005が表示するフォーク独自のGitHub Releaseノート
（Claudeが執筆した文章）を見て「これ誰が作ったの、公式なの、公式のchangelogを参照するだけで
いいのに誰が作れと言った、やり直して」と強く指摘。

### 調査で判明した事実

1. `~/.copilot-termux/<version>/changelog.json` は **バージョン番号をキーにした辞書**
   （273バージョン分、upstream `github/copilot-cli` の公式PRリンク付きエントリを保持）。
   `/changelog` コマンド（`nj.execute(t,[version])`）は引数のバージョンキーに対応する
   エントリだけを表示する契約。バージョン非依存ではなく、**渡した引数次第で正しい
   バージョンの公式内容がそのまま出る**ことを実機JSONで確認済み。
2. upstream本来のコード（UPDATE-004が上書きする前）:
   `if (!ELt.default.gt(u,a)) return nj.execute(t,[a])`
   の `a` は `xp()` = **app.js内でローカルに読み取る、今実際に動いているupstreamバイナリの
   バージョン**（`~/.copilot-termux/<version>/package.json` の version）。ネットワーク不要・
   常に実態と一致。
3. ユーザーは当初「フォークのnpm `latest` タグから `-N` サフィックスを除いたバージョンを
   changelogキーに差し込む」案を提示したが、**このマシンの現状**
   （ローカルで動くupstreamバイナリ=1.0.68、フォークのnpm `latest`タグ=1.0.65-1のまま、
   candidateで先行インストール中）で試算すると、その案では実際は1.0.68が動いているのに
   1.0.65のchangelogが表示されるという**ズレが発生する**ことが判明。
   `a`（現在ローカルで動いている実バイナリのバージョン）を使う方が常に正確。

### 結論・新方針

**UPDATE-004/005 のパッチコードを完全に削除し、upstream本来の
`return nj.execute(t,[a])` をそのまま実行させる（パッチ自体を当てない）。**

- `lib/platform-patch.js`:
  - UPDATE-005ブロック全体を削除
    （`FALLBACK_ENTRY`, `withTimeout`, `toDisplayVersion`, `RELEASE_NOTES_MAX_LINES/CHARS`,
    `truncateReleaseNotes`, `buildForkUpdateMessage`, `getForkUpdateMessage`,
    `globalThis.__COPILOT_TERMUX_FORK_UPDATE_MESSAGE__` 登録、
    `// === UPDATE-005 ===` 〜 `// === end UPDATE-005 ===`）
  - `patchAppJsSource()` 内の `CHANGELOG_FALLBACK_PATTERN` とその `if/else`
    （UPDATE-004/005の置換処理・`console.warn`込み）を削除
  - `INSTALL_CMD_PATTERN`（UPDATE-001）・`NOTIFY_PATTERN`（UPDATE-003）は**変更しない**
    （完全に独立した別の正規表現・別の`replace()`呼び出しであることをコードで確認済み）
- `lib/check-updates.js`:
  - UPDATE-005専用の `fetchReleaseNotes()` 関数と `RELEASE_OWNER`/`RELEASE_REPO`/
    `RELEASE_NOTES_MAX_BYTES` 定数を削除
  - `module.exports` から `fetchReleaseNotes` を除去
  - `resolveTarget`/`currentVersion`/`fetchVersionManifest`/`runUpdate`/`runNotify` は
    UPDATE-002/003（`copilot update`・起動時通知）が使用中のため**削除しない**
    （依存関係をコードで確認済み: `runNotify`/`runUpdate`が`resolveTarget`/`currentVersion`を使用）
- `package.json` の `copilotTermuxChangelog` フィールド: 6節時点の再設計で既に削除済み
  （今回の変更に含めるものはなし、確認のみでよい）
- テスト（`platform-patch.hook-verify.js` 等）から UPDATE-004/005 関連ケースを削除し、
  「CHANGELOG_FALLBACK_PATTERNが存在しない＝パッチが当たらない＝upstream標準コードのまま」
  ことを確認するテストに置き換える（または該当項目を削除するのみ）

### 効果

- `/update`実行時、更新なし判定なら upstream本来の `/changelog`（＝実際に動いている
  upstreamバイナリのバージョンの、upstream公式changelog.jsonの内容）がそのまま表示される
- フォーク独自の文章・GitHub API呼び出し・タイムアウト処理は一切なくなる
- `npm install -g @bash0816/copilot-termux` という表示（UPDATE-001）は変更なし・維持

### 次のステップ

STEP2 codexレビュー → Go なら Haiku（Agent tool `model="haiku"`）に実装委任 →
Sonnet独立検証 → 実グローバルインストールでスモークテスト →
ユーザーTUI実機確認 → npm publish

---

## 付録: TUI の Issues / Pull requests タブがグレーアウトする件（TAB-001・調査のみ）

ユーザーから「今回から Issue / Pull Request タブが追加されているがグレーで選択できない」との
指摘があったため、同じ 1.0.68 の実 app.js を調査した。

**結論: フォーク固有のバグではなく、upstream の意図した仕様。**

```js
var Uan=[{value:"copilot",label:"Session"},{value:"agents",label:"Agents"},
  {value:"issues",label:"Issues"},{value:"pull-requests",label:"Pull requests"},
  {value:"gists",label:"Gists"}],
  S9r=new Set(["issues","pull-requests"]);
function v9r(t){return t.map(e=>S9r.has(e.value)?{...e,disabled:!0}:e)}
function w9r(t={}){
  let{showGitHubRepositoryTabs:e=!0, ...}=t,
      l = e ? Uan : v9r(Uan);   // showGitHubRepositoryTabs が false の時だけ issues/pull-requests を disabled にする
  ...
}
```

呼び出し元は一貫して `showGitHubRepositoryTabs: Er.isGitHubRepository` を渡している。
`isGitHubRepository`（`useState(!1)` 初期値 false）は以下のロジックで決まる:

```js
useEffect(() => {
  if (!M.found) { H(!1); return }         // M = カレントディレクトリの git root 検出結果
  al(M.gitRoot).then(Le => {
    H(Le !== null);                        // al() = git remote から GitHub repo 情報(owner/repo/host)をパース
    C5(Le ? {owner:Le.owner, repo:Le.name, host:Le.host} : void 0)
  }).catch(() => H(!1))
}, [M])
```

つまり **`copilot` を起動したカレントディレクトリが「GitHub を remote に持つ git リポジトリの中」
でない限り、Issues / Pull requests タブは意図的に disabled になる**（Gists は disabled 対象の
Set に含まれていないため常に有効）。ユーザーの観察（標準＝Session と Gists だけ選べる）と完全に一致する。

**対応方針**: フォーク側のバグではないため修正不要。ユーザーが GitHub remote 付きの git
リポジトリ内で `copilot` を起動すれば Issues / Pull requests タブは有効になるはずなので、
そちらで再現するか確認してもらうのが次のアクション。今回のリリース判断としては
**ブロッカーにしない（Known/Expected behaviorとして許容）**。
