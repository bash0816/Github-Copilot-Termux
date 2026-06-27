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

| カテゴリ | 判定条件 | 対応 |
|---|---|---|
| tokio_noop_prefixes | `modelHttp*` や `networkFetch*` のように tokio 系の命名規則に乗る | no-op 化して落ちないようにする |
| git_async_stubs | `git[A-Z].*Async` に一致する | `async () => null` などの安全な JS スタブに置換する |
| behavioral_stubs | tokio / git ではないが、app.js の期待値に合わせた戻り値が必要 | app.js を読んで手動実装する |
| stream_pipeline_risk | `modelHttpStreamStart` / `modelHttpStreamNextAnthropicMessageEvent` / `modelHttpStreamCancel` / `responsesStreamDrive` | ストリーム経路のため自動パッチ対象外、必ず手動確認する |

### Step 3: カテゴリ別の対応

- `TOKIO_PATTERN` と `git*Async` は自動更新できる
- `behavioral_stubs` は手動で app.js を読んで戻り値・構造を合わせる
- `stream_pipeline_risk` は `processResult` の構造差分が壊れやすいので、自動化しない

### Step 4: テスト

```bash
copilot -p "1+1は？"
```

AI レスポンスが表示されれば OK

### Step 5: napi-known-exports.json を更新する

- 監査で確認できた新しいエクスポートを `config/napi-known-exports.json` に反映する
- 次回の監査で既知集合に含まれるようにして、ノイズを減らす

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

`stream_pipeline_risk` に該当する関数（`modelHttpStreamStart` / `modelHttpStreamNextAnthropicMessageEvent` / `modelHttpStreamCancel` / `responsesStreamDrive`）が変更された場合:

1. app.js でその関数の呼び出し箇所と引数・戻り値の期待値を確認する
2. `processResult` の構造（`chunkContext` / `tokenEvent` / `copilotUsage` など）を照合する
3. 自動パッチの対象外として、必ず手動で対応する

## napi-audit.js の使い方

```bash
# dry-run（変更なし）
node scripts/napi-audit.js ~/.copilot-termux/current/runtime.node 1.0.66

# 自動パッチ適用（TOKIO_PATTERN と git*Async のみ）
node scripts/napi-audit.js ~/.copilot-termux/current/runtime.node 1.0.66 --auto-patch
```

出力 JSON の各フィールドの意味:

- `newTokio`: `tokio_noop_prefixes` に一致したが、まだ known set にない候補
- `newGitAsync`: `git[A-Z].*Async` に一致した新しい候補
- `newUnknown`: 上記以外で、長さ 15 文字以上の未分類候補
- `patchApplied`: `--auto-patch` 実行時にパッチ処理を走らせたかどうか
- `version`: 監査対象として渡した Copilot バージョン
- `summary`: 候補数と分類結果の要約

## 自動パッチの安全境界

| 操作 | 自動化 | 理由 |
|------|--------|------|
| `TOKIO_PATTERN` に新プレフィックス追加 | 可 | no-op は常に安全 |
| `git*Async` に `async () => null` 追加 | 可 | git 系は null / 空で安全に倒せる |
| behavioral stub の追加・修正 | 不可 | app.js の期待値確認が必須 |
| 既存スタブの削除 | 不可 | 破壊的変更 |

