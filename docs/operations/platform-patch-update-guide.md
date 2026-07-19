# platform-patch.js 更新ガイド

## なぜ platform-patch.js が必要か

- Android bionic (Termux) では glibc/musl の pthread ABI が異なり、Rust tokio が SIGSEGV を起こす
- GitHub Copilot の runtime.node (linuxmusl-arm64) は Rust tokio で実装された NAPI 関数を多数エクスポートする
- platform-patch.js は Module._load をフックし、runtime.node ロード後にこれらの関数を Node.js ネイティブの JS 実装で置き換える（no-op または動作スタブ）

## 更新が必要になるタイミング

- 新バージョンが出て、runtime.node のエクスポート集合が変わったとき
- 既存の no-op / stub と一致しない新しい NAPI エクスポートが追加されたとき
- 既存スタブの戻り値や構造が app.js の期待値と乖離し、UI や API 呼び出しが壊れたとき

## 更新手順

### Step 1: napi-audit.js で新エクスポートを確認する

```bash
# 実機の runtime.node を使って dry-run
node scripts/napi-audit.js ~/.copilot-termux/current/runtime.node 1.0.66
```

### Step 2: エクスポートを4カテゴリに分類する

`napi-audit.js`の`classifyCandidates()`が判定する順序・条件は以下の通り（実装と一致させること）:

| 監査結果カテゴリ | 判定条件(実装順) | 対応 |
|---|---|---|
| newStreamRisk | 既知集合(`tokio_noop_prefixes`/`behavioral_stubs`/`git_async_stubs`/`stream_pipeline_risk`)・`pending_git_async_stubs`のいずれにも該当せず、候補名に`Stream`を含む(位置は問わない) | ストリーム経路のため自動パッチ対象外、必ず手動確認する |
| newTokio | `tokio_noop_prefixes`のいずれかで始まる(`modelHttp*`や`networkFetch*`等) | `TOKIO_PATTERN`へno-op化して自動反映。config(`tokio_noop_prefixes`)へも自動追記 |
| newPendingGitAsync | `^git[A-Z].*Async$`に一致する | public configへは書き込まない。private repoのissueで手動レビューし、実装が必要と判断したもののみ `platform-patch.js` に実装した上で `git_async_stubs` に直接追記する（2026-07-19、public config漏洩対策のため中間状態のpublic永続化を廃止） |
| newUnknown | 上記のいずれにも該当せず、先頭が小文字かつ長さ15文字以上 | app.js を読んで手動実装が必要か判断する（public configの `behavioral_stubs` フィールドへの自動記録は廃止済み、2026-07-19） |

上記4カテゴリとは別に、実装済みスタブの追跡用configフィールドとして`git_async_stubs`(実装済みgit非同期系)・
`stream_pipeline_risk`(実装済みstream系)がある。これらは監査結果カテゴリではなく、手動で実装した関数を
記録する台帳であり、`loadKnownSet()`が次回監査で「既知」として除外するために参照する。

### Step 3: カテゴリ別の対応

- `newTokio`: `--auto-patch`で`TOKIO_PATTERN`へ自動反映を試みる。`TOKIO_PATTERN`行が単一行かつ想定書式に
  一致しない場合は反映に失敗し、出力の`tokioPatchOk`が`false`になる(この場合configにも記録されない)。
  `--auto-patch`実行後は必ず`tokioPatchOk === true`であることを確認すること。また、単純にno-op化するだけで
  問題ないかも個別に確認する(下記「自動パッチの安全境界」の`networkFetchNextRequestId`の例を参照)
- `newPendingGitAsync`: public configへ自動記録しない。private repoのissueでレビューし、
  実装する場合のみ`platform-patch.js`に実装した上で`git_async_stubs`に追記する
- `newUnknown`: app.jsの期待値に合わせた戻り値実装が必要かどうか、手動でapp.jsを読んで判断・実装する
- `newStreamRisk`: `processResult` の構造差分が壊れやすいので、自動化しない。手動実装後は`stream_pipeline_risk`に追記する

### Step 4: テスト

```bash
copilot -p "1+1は？"
```

AI レスポンスが表示されれば OK

### Step 5: git_async_stubs を更新する（実装した関数のみ）

- `TOKIO_PATTERN`は`--auto-patch`で自動更新される
- `newPendingGitAsync`/`newUnknown`はpublic configへ反映しない（2026-07-19廃止、private repoの
  issueで内部監査データを都度レビューする運用に統一。詳細は
  `bash0816/Github-Copilot-Termux-Private`の`docs/KNOWN-BUGS.md`GIT-LEAK-001参照）
- 実際に`platform-patch.js`へスタブを実装した関数のみ、`config/napi-known-exports.json`の
  `git_async_stubs`に手動で追記する（次回監査で既知集合に含まれノイズが減る）

## 事例: chunkContext 修正（2026-06-27 / copilot 1.0.65）

### 現象

`copilot -p "1+1は？"` でレスポンスが表示されない。
`COPILOT_TERMUX_DEBUG_AUTH=1` で accumulator に `"text:2です。"` が蓄積されていることは確認できた。

### 根本原因

`modelHttpStreamNextAnthropicMessageEvent` スタブの `processResult` に `chunkContext` フィールドが欠けていた。
app.js の `processAnthropicStreamingChunkContext()` は `n.chunkContext` が null/undefined のとき `onStreamingChunk()` を呼ばないため、`emitEphemeral("assistant.message_delta")` が発火せず stdout 出力なし。

### 調査方法

app.js の `processAnthropicStreamingChunkContext` 関数（約 line 1004162）を確認。
`n.chunkContext` の nil チェックを発見し、スタブの `{ event }` と app.js の期待値 `{ event, chunkContext, tokenEvent, copilotUsage }` の乖離を特定した。

### 修正内容

`_toChunkContext(event, streamId)` ヘルパーを追加し、Anthropic SSE イベント型（`message_start` / `content_block_delta` / `content_block_stop` / `message_stop`）を chunkContext オブジェクトに変換する。

スタブ戻り値は次の形に修正する。

```js
return { json: JSON.stringify({
  kind: 'ok',
  processResult: { event, chunkContext, tokenEvent, copilotUsage: null }
})};
```

### 教訓

- スタブの戻り値は「何を返せばアプリが動くか」まで app.js を読んで確認する
- TOKIO_PATTERN の no-op 後に behavioral stub で上書きしているため、no-op 自体は問題なかった
- 確認パス: `copilot -p` → `emitEphemeral("assistant.message_delta")` → `process.stdout.write`
- 調査起点: `COPILOT_TERMUX_DEBUG_AUTH=1` のデバッグログ

## ストリームパイプライン変更時の注意点

`stream_pipeline_risk` に該当する関数（`modelHttpStreamStart` / `modelHttpStreamNextAnthropicMessageEvent` / `modelHttpStreamCancel` / `responsesStreamDrive` / `chatCompletionStreamDrive`。実装済みとして`config/napi-known-exports.json`に記録済みのもの。新規に名前へ`Stream`を含む候補は`newStreamRisk`として監査で検出される）が変更された場合:

1. app.js でその関数の呼び出し箇所と引数・戻り値の期待値を確認する
2. `processResult` の構造（`chunkContext` / `tokenEvent` / `copilotUsage` など）を照合する
3. 自動パッチの対象外として、必ず手動で対応する

## napi-audit.js の使い方

```bash
# dry-run（変更なし）
node scripts/napi-audit.js ~/.copilot-termux/current/runtime.node 1.0.66

# 自動パッチ適用（TOKIO_PATTERN のみ。newPendingGitAsync/newUnknownはpublic configへ保存しない）
node scripts/napi-audit.js ~/.copilot-termux/current/runtime.node 1.0.66 --auto-patch
```

出力 JSON の各フィールドの意味:

- `newStreamRisk`: 既知集合・pending集合のいずれにも含まれず、候補名に`Stream`を含む新しい候補
  （4カテゴリの中で最優先に判定される、必ず手動確認）
- `newTokio`: `tokio_noop_prefixes` に一致したが、まだ known set にない候補
- `newPendingGitAsync`: `^git[A-Z].*Async$` に一致した新しい候補（手動レビュー待ち）
- `newUnknown`: 上記のいずれにも該当せず、先頭が小文字かつ長さ15文字以上の未分類候補
- `patchApplied`: `--auto-patch` 実行時に実際にファイル変更(TOKIO_PATTERN更新等)が発生したかどうか
  (パッチ処理自体を走らせたかどうかではなく、結果として差分が生じたかを表す)
- `tokioPatchOk`: `newTokio`が0件の場合、または`--auto-patch`指定で`TOKIO_PATTERN`への反映に成功した
  場合`true`。`--auto-patch`なし(dry-run)で`newTokio`が1件以上ある場合は、反映を試みていなくても
  `false`になる(「反映に失敗した」ではなく「まだ反映されていない」という意味)。`--auto-patch`実行後は
  必ず`true`であることを確認すること
- `version`: 監査対象として渡した Copilot バージョン
- `summary`: 候補数と分類結果の要約

## 自動パッチの安全境界

| 操作 | 自動化 | 理由 |
|------|--------|------|
| 新規`newTokio`候補(関数名)を`TOKIO_PATTERN`へ追記 | 可(ただし`--auto-patch`後は`tokioPatchOk`が`true`であることを必ず確認する) | no-opが常に安全とは限らない。例: `networkFetchNextRequestId`は`networkFetchStreamStart`/`RequestCancel`の相関キーとして実際に使われるため、一括no-op化後にJSの単調増加ID生成で明示的に上書き実装されている(`platform-patch.js`)。新規追加分についても、単純にno-opで問題ないか個別に確認すること |
| `git*Async` を `git_async_stubs` に追記 | 不可（実装後に手動追記のみ） | public configへの中間状態(未実装分)の自動記録は2026-07-19に廃止。戻り値型が様々なため自動スタブ化自体も危険 |
| behavioral stub の追加・修正 | 不可 | app.js の期待値確認が必須 |
| 既存スタブの削除 | 不可 | 破壊的変更 |

