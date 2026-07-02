# copilot@1.0.68 対応・Watch自動化強化プラン（2026-07-03・改訂版）

## 発端

ユーザー指示: 「copilotの1.0.68アップデートを進める。今回の知見（1.0.65→1.0.65-1で発生した
TUI login regression・SQLite handle・CA証明書・UPDATE-001〜004・MANIFEST-001ドキュメント漏れ等の
一連のトラブル）を活かし、Watchから修正までの自動化を進めていく」。
その後「自動化については ClaudeCode-Termux (private) で既にやっているので、それを参考に」との
追加指示があり、本改訂版はその既存実装（`claude-native-version-watch.yml` および関連スクリプト）
のアーキテクチャに合わせて設計し直したもの。

## 現状調査（2026-07-03実施）

### 1. upstream は既に 1.0.68、fork側は 1.0.65 のまま未追従

```
npm view @github/copilot version  → 1.0.68
manifest.json の copilot_version  → 1.0.65
```

### 2. `Copilot version watch` ワークフローが2日連続で失敗している（重大）

```
2026-07-02  failure
2026-07-01  failure
2026-06-30  success（以前）
```

**根本原因**: `scripts/napi-audit.js` の `extractCandidates()`（71行目）が

```js
const output = execSync(`strings -n 8 ${shellQuote(runtimePath)}`, { encoding: 'utf8', ... });
```

で `strings` の出力を丸ごとキャプチャしているが `maxBuffer` を指定していない
（デフォルト1MB）。upstream の Rust ネイティブバイナリ `runtime.node` は文字列テーブルが
巨大で `Error: spawnSync /bin/sh ENOBUFS` により例外送出 → ジョブ全体が `failure`。

副作用: 後続の「commit & push」ステップは前段失敗により `skipped` になっており、
リポジトリへの誤コミットは発生していない（実害は「2日分の自動検知が無効化されていた」のみ）。

### 3. 参考実装（ClaudeCode-Termux private）の調査結果

`CluadeCode-Termux-private/.github/workflows/claude-native-version-watch.yml` と、それが
`bash0816/ClaudeCode-Termux`（公開repo）に対して実行する一連のスクリプトを確認した。
copilot-termux の現行実装（Watch）と比べて、以下の点で明確に優れている:

| 観点 | copilot-termux（現行） | ClaudeCode-Termux（参考実装） |
|------|------------------------|-------------------------------|
| バイナリからの情報抽出 | `strings` コマンドを subprocess 実行し、出力を丸ごとキャプチャ（**ENOBUFSの原因**） | `fs.readFileSync(binary)` で Node 内に直接読み込み、`Buffer.indexOf` でオフセット探索。subprocess のstdoutキャプチャに巨大バイナリを流さない設計のため、原理的にENOBUFSが起きない |
| 変更の反映先 | Watch が直接 `main` に commit & push | `automation/native-claude-<version>` ブランチを作成し、PRを立てる（mainへの直接pushをしない） |
| 重複実行対策 | なし（manifestの`copilot_version`比較のみ） | `config/claude-native-audited-versions.json` に per-version status を永続化し、既知バージョンは`should_intake=false`でスキップ。加えて既存ブランチ/オープンPRの有無もチェックする「duplicate guard」あり |
| README/manifest更新 | Watch内でmanifest.json/package.jsonを直接書き換え | `status`フィールド付きの単一ソース（audited-versions.json）から `update-release-manifest.js` / `update-readme-version-guidance.js` が **生成**する。手動編集や記載漏れが起きない設計 |
| 検証との連携 | Watch成功後に`npm-package.yml`をverify-onlyでdispatch（mainに対して） | 候補ブランチ・PR自体がCIの対象になり、mainには一切触れない状態でverifyが回る |

**今回のMANIFEST-001（wrapperバージョン記載とドキュメントの乖離が長期間放置された）や
UPDATE-004のような「ドキュメントが実態と食い違う」問題は、まさに ClaudeCode-Termux が
「単一ソース(JSON)から生成する」設計で構造的に防いでいる領域である。**
copilot-termux 側もこの設計に寄せることで、同種の問題を今後カテゴリごと防げる。

## 修正方針（ClaudeCode-Termux方式に準拠）

### STEP A（最優先・ENOBUFSの根本修正）

`scripts/napi-audit.js` の `extractCandidates()` を `strings` subprocess方式から
`fs.readFileSync` + 自前の印字可能文字列スキャン（Node純正実装）に置き換える。
`strings -n 8`相当のロジック（8バイト以上の印字可能ASCII連続列を抽出）をJSで実装する。

- 参考: `termux-prepare-claude-native-version.js` の `discoverOffsets()` は
  `fs.readFileSync` + `Buffer.indexOf` のみで完結しており、subprocessのstdoutキャプチャに
  巨大バイナリのデータを一切流していない。copilot-termuxのケースは「2つの既知マーカーの
  オフセットを探す」のではなく「候補文字列を網羅的に抽出する」ため単純な移植はできないが、
  **「巨大バイナリのデータをsubprocessの標準出力経由でNodeに戻さない」という設計原則は
  そのまま踏襲できる**。バッファ上限の心配自体がなくなる（`maxBuffer`を大きくするその場しのぎ
  ではなく、根本的にsubprocess経由の転送をやめる）。
- 出力対象の文字列は既存の正規表現（`/^[a-zA-Z_$][a-zA-Z0-9_$]{6,}$/`、`classifyCandidates`側）
  でフィルタされるため、抽出ロジックの置き換えは `extractCandidates()` 内部に閉じる
  （呼び出し側・分類ロジックは変更不要）。

### STEP B（アーキテクチャ変更）: Watch を「main直接push」から「候補ブランチ+PR」方式へ

`copilot-version-watch.yml` を以下のように再設計する:

1. **per-versionの永続化台帳を新設**: `config/copilot-audited-versions.json`
   （ルートと `packages/copilot-termux/config/` の2箇所、ClaudeCode-Termuxと同じ二重管理パターン）
   に `{ versions: { "1.0.68": { status, napi_audit_summary, ... } } }` を記録する。
   `status` は `napi_audited`（新規exportなし・自動パッチ適用済み）→
   `needs_manual_review`（newUnknown等あり・人間の実装待ち）→
   `termux_verified`（実機スモークテスト完了）の3段階遷移とする。
2. **skip_existing**: 台帳に既に存在するバージョンは再処理しない（現行は毎回`manifest.copilot_version`との単純比較のみで、PRがマージされるまでの間に複数回Watchが走ると重複処理される恐れがあった）。
3. **duplicate guard**: `automation/copilot-<version>` ブランチや同種のオープンPRが既にあれば
   スキップする（ClaudeCode-Termuxと同じロジックをそのまま移植）。
4. **候補ブランチ + PR**: NAPI監査・manifest/package.json更新・README生成（後述STEP D）を
   すべて候補ブランチ上で行い、`main`には一切直接触れない。PRを作成して人間のレビュー・
   実機スモークテストを経てマージする。**現行の「Watch成功→即main push→即npm-package.yml
   verify dispatch」という直列自動化より安全**（今回のように NAPI 監査が例外を吐いた場合も
   mainに影響が及ばない）。
5. Watch自体の失敗（今回のENOBUFSのようなケース）を早期発見するため、Watchジョブに
   Slack/Issue通知等は現状ないため、**2日連続 `failure` の見逃しは今回ユーザー指摘で発覚した
   ことを教訓とし**、最低限 `workflow_dispatch` での手動実行を定期的に確認する運用注記を
   `docs/operations/` に残す（恒久的な通知の仕組みまでは今回のスコープ外・過剰実装を避ける）。

### STEP C: MANIFEST-001 / UPDATE-004 系の再発防止（ドキュメント生成の単一ソース化）

ClaudeCode-Termuxの `update-release-manifest.js` / `update-readme-version-guidance.js` に
倣い、README.md の Status セクション・RELEASES.md のバージョン一覧を
`config/copilot-audited-versions.json` の `status` から**生成**する（手動編集をやめる）。
これにより「実装は直っているがドキュメントが古いまま」という今回のMANIFEST-001と同種の
問題がカテゴリごと再発しなくなる。

**scope注意**: 今回のREADME/RELEASES.md（1.0.65-1向け）は既に手動更新済み（commit `11c8c72`）。
このSTEP Cは次回（1.0.68以降）の更新から生成方式に切り替える、という意味であり、
過去の手動更新をやり直す必要はない。

### STEP D: 引き続き自動化しない範囲（変更なし・重要）

- TUIログイン挙動・SQLite handle・pty.node ABI等の「実際に動くかどうか」の検証は、
  引き続き実機TUIテスト（ユーザー確認）が必須。ClaudeCode-Termux側も`termux_verified`への
  昇格は自動化しておらず、同じ考え方。
- NAPI監査で `newUnknown`（未知エクスポート）が検出された場合の実装内容判断は、
  引き続き Codex(gpt-5.5)/人間のレビューを経て候補ブランチ上で行う。自動パッチは
  `newTokio` の no-op化のみ（既存方針を維持）。

## 1.0.68 対応の実行プラン（順序）

1. STEP A（`napi-audit.js` の `strings` subprocess廃止・buffer直読み方式への置き換え）を実装・
   ローカルで実際に `@github/copilot-linuxmusl-arm64@1.0.68` をpackして動作確認・codexレビュー
2. STEP B（`copilot-version-watch.yml` を候補ブランチ+PR方式に再設計、
   `config/copilot-audited-versions.json` 新設）を実装・codexレビュー
3. STEP C（README/RELEASES.md生成スクリプトの追加）は次回サイクルで着手可（今回1.0.68対応の
   ブロッカーではないため、A・Bより優先度を下げてよい。ユーザー判断を仰ぐ）
4. `Copilot version watch` を `workflow_dispatch` で手動実行 → 1.0.68検知 → 候補PR作成を確認
5. PR上のNAPI監査結果を確認、`newUnknown`があれば platform-patch.js 追加対応
6. 実機スモークテスト（候補ブランチのtgzを実際にインストール、`docs/SMOKE-TEST.md`準拠・TUI含む）
7. PRマージ → `npm-package.yml` を通常フロー（publish→ユーザー承認→retag_latest）で実行
8. README.md / RELEASES.md / KNOWN-BUGS.md 更新（STEP C導入前なら引き続き手動）

## リスク・スコープ判断

- STEP Bは既存Watchワークフローの構造を作り直す比較的大きな変更。1.0.68検知という
  差し迫った目的に対してオーバースペックに見える可能性があるため、**codexレビューで
  「STEP AのみでWatchを復旧し、STEP B/Cは別issueとして切り出すべきか」の判断を仰ぐ**。
- 「Watchから修正まで完全自動化」は挙動バグ（TUI login regression等）の性質上、
  引き続き不可能。今回のプランは「検知・記録の自動化と安全性の強化」に留める。
- STEP A/BはCI/ワークフローの変更であり、npm publish には直結しない
  （`npm-package.yml` の publish job は引き続き `npm-publish` environment 承認が必須、変更なし）。

## STEP2レビュー結果（2026-07-03・Opus 4.8 サブエージェント判定）

**判定: Conditional Go**

GPT-5.5（codex exec）に2回依頼したが両方タイムアウトしたため、Opus 4.8をサブエージェントとして
起動しレビューを実施（`/advisor`は廃止済みのためAgentツール `model="opus"` で代替、ユーザー確認済み）。

**Blocker（実装前に解消必須）**:
1. STEP Aの「`strings`サブプロセス廃止→Node内Buffer直読み+自前スキャン」は方向性として正しいが、
   `strings -n 8`の実際の挙動（0x20-0x7eの印字可能ASCIIの**極大連続run**を1トークンとして
   切り出し、最小長8を満たすものだけ出力）を正確に再現しないと、抽出される candidate 集合が
   変わり `newUnknown` の誤検出・見落としが起きる。Bufferは **latin1（バイナリ）で走査し、
   utf8デコードは行わない**こと。
   → **1.0.65の実バイナリ（`~/.copilot-termux/1.0.65/prebuilds/linuxmusl-arm64/runtime.node`、
   既に手元にある）に対して、旧`strings`方式と新Node実装の抽出結果が完全一致（diff ゼロ）に
   なることを検証する回帰テストを実装に含める**（CLAUDE.mdの「同じ問題を2回起こさない」に
   基づきユニットテスト化する）。
2. Watchワークフローが2日間サイレントに失敗し続けた再発防止として、**STEP Aの実装時点で**
   ワークフローに `if: failure()` ステップを追加し、失敗時にGitHub issueを自動起票する
   （ドキュメント注記だけでは不十分、との指摘。低コストで高価値なため後回しにしない）。

**スコープ判断（確定）**:
- STEP Bは差し迫ったCI復旧という目的に対してオーバースペック。root＋package二重台帳は
  同期ドリフトという新たなfootgunを生むリスクがあり、今回は見送る。
  **STEP AのみでWatchを復旧し、STEP B（候補ブランチ+PR方式への刷新）とSTEP C
  （README/RELEASES.md生成方式）は別issueとして切り出す**。
- STEP D（TUI挙動バグ系は手動テストのまま）は変更なし。

## STEP8コーディングレビュー結果（2026-07-03・codex(gpt-5.5)、`codex exec review --commit`）

対象: `d477d92`（napi-audit ENOBUFS修正）・`b0f2bc5`（issue本文上限修正）・`c1a6738`（UPDATE-004）
の3コミットを個別にレビュー。**判定: Go（Blockerなし、P2非ブロッカー2件）**

1. **[P2] `scripts/napi-audit.js:73-76`**: 新しい`extractCandidates()`（`fs.readFileSync`+
   自前スキャン方式）は、タブ文字(`\t`)を含む文字列に対して`strings -n 8`と異なる挙動をする。
   `strings`はタブを含む1行を印字可能文字の連続runとして扱うが、新実装はタブを区切り文字として
   扱うため、`prefixxx\tveryLongIdentifier`のようなバイナリ内容に対し旧実装は`[]`（識別子正規表現
   に一致せず除外）、新実装は`['prefixxx','veryLongIdentifier']`（2件抽出）という差異が出る。
   実バイナリ(1.0.65のruntime.node)でのパリティテストは一致(diffゼロ)したため今回の1.0.68検知
   には実害なしだが、将来のバイナリでタブ含み文字列があれば`newUnknown`の誤検出（ノイズ）に
   つながる。**次回napi-audit.js改修時に修正対象とする（今回はブロッカーではない）**
2. **[P2] `.github/workflows/copilot-version-watch.yml:179-180`**: issue本文が50000文字上限で
   切り詰められた場合、「省略分はworkflow runのログで確認」と案内するが、実際にはワークフローが
   `AUDIT_JSON`や省略された全件リストをログに出力していないため、切り詰め発生時は省略された
   NAPIエクスポートを確認する手段がない。**次回Watch改修時にログ出力またはartifact添付を追加**

`c1a6738`（UPDATE-004）は指摘なし。`platform-patch.js`の`patchAppJsSource()`を実際の
`~/.copilot-termux/1.0.65/app.js`に適用し、戻り値契約維持・構文妥当性を確認した上で
「discrete regression なし」と判定。

いずれもBlocker（実装前解消必須）扱いではなく、release可否には影響しない非機能改善事項として
記録。

## 確定した実行プラン（1.0.68対応・改訂）

1. **STEP A実装**（今回のスコープ）:
   a. `napi-audit.js` の `extractCandidates()` を `fs.readFileSync` + latin1走査の自前スキャンに置換
   b. 1.0.65の実バイナリで旧`strings`方式との出力パリティ回帰テストを追加（diffゼロを確認）
   c. `copilot-version-watch.yml` に `if: failure()` でissue自動起票するステップを追加
2. Haikuに実装委任（Agentツール `model="haiku"`）→ Sonnet(自分)が確認 → Opusサブエージェントで再レビュー、Goになるまで繰り返す
3. `Copilot version watch` を `workflow_dispatch` で手動実行 → 1.0.68検知・NAPI監査が正常終了することを確認
4. NAPI監査結果（`newUnknown`等）を精査、必要なら `platform-patch.js` 追加対応
5. 実機スモークテスト（`docs/SMOKE-TEST.md`準拠、TUI含む）
6. candidate publish → ユーザー実機確認（別マシンglibc mode含む）→ latest 昇格
7. README.md / RELEASES.md / KNOWN-BUGS.md 更新
8. STEP B/C は別issueとして切り出し、次サイクル以降でユーザーと再検討
