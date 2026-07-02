# npm リリースパイプライン調査・修正プラン（2026-07-02）

## 発端

ユーザーが `copilot update` を実行し、以下の出力を「バグ」として報告:

```
$ copilot update
No newer candidate or stable version available: 1.0.65-1
To rollback to stable: DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix $PREFIX @bash0816/copilot-termux@latest
```

## 調査結果

### 1. `copilot update` の出力自体は設計通り正しい

`packages/copilot-termux/lib/check-updates.js` の `resolveTarget()` は、ローカルバージョンが
registry の `candidate`/`latest` 両方以上であれば `null` を返し、update を行わない
（ダウングレード防止・強制更新なしが要件）。

このマシンの状態:
- ローカル: `1.0.65-1`（TUI login regression 修正・SQLite fix・CA fix・UPDATE-002 fix 込み）
- npm dist-tags: `candidate=1.0.63`, `latest=1.0.63`, `previous_stable=1.0.63`

→ ローカルが registry より進んでいるため「更新不要」は正しい判定。**バグではない。**

**設計原則（確定・今後もこの方針）**: ローカルバージョンが registry の候補（`candidate`/`latest`）
以上の場合は何もしない。exit 0 で情報メッセージのみ表示し、強制的な書き換え・ダウングレードは行わない。

### 2. 本当の問題（3件）

#### (a) `docs/SMOKE-TEST.md` に `copilot update` 自体のテストケースが存在しない

TC-1〜TC-6 は認証・モデル選択のみを対象としており、UPDATE-002 で実装した
`copilot update` の動作（新バージョンあり／ローカルが先行／同一バージョン／ネットワーク失敗）
は一度もスモークテスト手順に組み込まれていなかった。
`docs/KNOWN-BUGS.md` には「UPDATE-002 ✅ 修正済み（2026-07-02）」と記録されているが、
その根拠となるテストケースが存在しないため「スモークテスト完了」の主張と実態が乖離していた。

#### (b) npm への実 publish が一度も実行されていない

- `packages/copilot-termux/config/copilot-termux-release-manifest.json` は
  `latest_candidate_version: "1.0.65-1"` を記録しているが、これは **manifest 上の希望値**であり、
  npm registry の実際の dist-tag (`candidate=1.0.63`) とは同期していない。
- 1.0.65-1 はこれまで private repo (`Github-Copilot-Termux-Private`) の tgz を
  各検証マシンに手動 `npm install -g <tgz>` することでのみ配布・検証されてきた。
- **実際の公開経路（`npm install -g @bash0816/copilot-termux@candidate`）は一度も検証されていない。**
  `copilot update` が正しく candidate を取得できるかは、publish 後でないと確認できない。

#### (c) 開発リポジトリの未反映変更

- `Github-Copilot-Termux`（開発リポジトリ）は `origin/main` に対し **9 commits 先行**、未 push
  （UPDATE-002 実装コミット `a1432ad` を含む）
- 未コミットの変更が2件残っている:
  - `.github/workflows/npm-package.yml` — `retag_latest` 入力を追加し、candidate→latest 昇格を
    同一ワークフローに統合する変更
  - `.github/workflows/promote-and-publish.yml` — 上記に伴い deprecated 化
  - `scripts/retag-latest-dist-tags.js`（未追跡）— retag 処理の実体
- **さらに `.github/workflows/retag-latest.yml` という別の retag ワークフローが既に存在し、
  コミット済み・現役として残っている。** これは `npm dist-tag add ... latest` のみを行う
  シンプル版で、`scripts/retag-latest-dist-tags.js`（candidate 昇格時に旧 latest を
  candidate に退避する版）とロジックが異なる。**2つの retag 手段が並存しており、
  どちらを使うべきか一意に決まっていない。** これは今回の作業スコープでは実行しないが、
  次の publish 作業に着手する前に整理が必要。

### 3. 副次的リスク（記録のみ・今回は対応しない）

npm registry には既に `1.0.65`（プレリリースでない完全版、2026-06-28 公開、
TUI login fix 等を含まない古いビルド）が存在し、dist-tag からは外れて孤立している。
semver では `1.0.65-1` のようなプレリリース版は同じ `1.0.65` の正式版より **常に精度が低い**
（`1.0.65-1 < 1.0.65`）。将来 `candidate` タグを `1.0.65-1` に向けても npm 標準の
semver range 解決には影響しないが（このプロジェクトの `check-updates.js` は
dist-tag を直接参照する自前実装のため実害はない）、`npm view` でバージョン一覧を見た人が
混乱する・将来的な version bump 先で衝突するリスクがある。次の publish 作業時に
`1.0.66` へのバンプを検討する。

## codex（gpt-5.5）STEP2レビュー結果（2026-07-02・1回目）

**判定: Conditional Go**

- `check-updates.js` の設計原則（ローカルが registry 以上なら何もしない）は **Go**
- `docs/SMOKE-TEST.md` / `docs/KNOWN-BUGS.md` への追記は **Go**
- workflow 変更のコミット&push は **No-Go 寄りの Conditional Go**。以下 Blocker を解消してから。

**Blocker**

1. `copilot-version-watch.yml:153` が壊れる — `npm-package.yml` から `npm_tag` 入力を削除したのに
   version-watch はまだ `--field npm_tag=candidate` を渡している。新 workflow が push されると
   自動 dispatch が unknown input で失敗する。→ `npm_tag` を削除し `--field publish=false --field retag_latest=false` に変更。
2. `retag-latest.yml` と新 `retag_latest` 機構が並存するのは No-Go — 既存 workflow は
   candidate 退避・manifest 更新なしで任意バージョンを `latest` にできてしまう。
   → 既存 `retag-latest.yml` を deprecated fail にする（`promote-and-publish.yml` と同じ扱い）。
3. manifest の canonical パスが食い違う — 旧 `npm-package.yml`/`copilot-version-watch.yml` は
   top-level `config/copilot-termux-release-manifest.json` を使うが、新変更は package 内
   `packages/copilot-termux/config/...` だけを更新する。しかも現状この2ファイルは
   スキーマも内容も既に矛盾している（top-level: `candidate_state=promoted`,
   `latest_candidate_version=null` / package内: `latest_candidate_version=1.0.65-1`）。
   → package 内 manifest を canonical とし、top-level 版は削除するか package 内へのシンボリック
   参照にする。`copilot-version-watch.yml` の参照先も合わせて修正。
4. `compareVersions()` の prerelease 比較は `x.y.z-N`（数字のみ）前提であれば問題ないが、
   汎用 semver として扱うなら英数混在の prerelease 比較に穴がある。
   → 現行運用が `x.y.z-N` 固定である旨をコード内コメントで明記し、スモークテストに
   prerelease 比較の境界ケースを追加する（Blocker ではなく Non-blocker 相当だが対応する）。

**Non-blocker（参考・今回は対応しない）**

- 次回 publish のバージョンは `1.0.66` にする（`1.0.65-1 < 1.0.65` が npm 上に既に存在するため）
- `scripts/retag-latest-dist-tags.js` の未使用 `pkg` 変数削除
- `previous_stable` dist-tag は新 retag script で更新されない（rollback 用途で使うなら明確化要）

## 追加発見（2026-07-02・作業再開時にユーザー指摘）

### 問題: `runUpdate()` のメッセージがローカル先行時に矛盾する

TC-U2 のケース（ローカル `1.0.65-1` が registry の `candidate`/`latest`（`1.0.63`）より
先行）で実際に `copilot update` を実行した際の出力:

```
No newer candidate or stable version available: 1.0.65-1
To rollback to stable: DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix <prefix> @bash0816/copilot-termux@latest
```

「更新なし」と言っているのに直後に「安定版へ rollback しろ」という案内が出るのは矛盾している。
`1.0.65` は不具合があり取り下げ済みで、現在 `1.0.65-1` として修正作業中という正常な開発フロー
であり、rollback を促す文言は不要かつ誤解を招く。

### 原因

`packages/copilot-termux/lib/check-updates.js` の `runUpdate()`:

```js
if (!targetVer) {
  if (isPrerelease(currentVersion)) {
    console.error(`No newer candidate or stable version available: ${currentVersion}`);
    console.error(`To rollback to stable: DISABLE_INSTALLATION_CHECKS=true npm install -g --prefix ${npmPrefix} ${packageName}@latest`);
  } else {
    console.error(`Already on latest version: ${currentVersion}`);
  }
  return 0;
}
```

`resolveTarget()` が `null` を返す（＝ローカルが `latest`/`candidate` 以上で更新不要）という
状況は共通なのに、表示メッセージの分岐条件が「ローカルのバージョン文字列にハイフンが
含まれるか（`isPrerelease`）」だけになっている。ローカルが先行している「問題ない」状況でも、
バージョン番号がたまたま prerelease 形式というだけで rollback を促す紛らわしい文言になる。

### 修正方針（ユーザー確認済み・2026-07-02）

`isPrerelease` による分岐を削除し、`!targetVer` の場合は常に
`Already on latest version: ${currentVersion}` を表示する形に統一する。
rollback 用の手動コマンド案内は自動メッセージからは削除する
（rollback したい場合は運用ドキュメント側の手順を参照させる。今回のスコープでは
自動メッセージの簡素化のみ行う）。

修正対象: `packages/copilot-termux/lib/check-updates.js` の `runUpdate()` 内
`if (!targetVer) { ... }` ブロック。

この修正に伴い、`docs/SMOKE-TEST.md` の TC-U2 の期待メッセージも
`Already on latest version: ${currentVersion}` に統一する（TC-U3 と同じ表示になる）。

## プラン（確定版・今回のスコープ）

**方針**: 今回は「実際の npm publish」は行わない（本番 registry への反映は別途ユーザー承認後）。
ユーザー承認により、workflow の Blocker 4件も含めて今回まとめて対応する。

1. `docs/SMOKE-TEST.md` に UPDATE-002 用テストケースを追加する
   - TC-U1: registry に新バージョンあり → update 実行される
   - TC-U2: ローカルが registry (candidate/latest) より先行 → `Already on latest version` メッセージ・exit 0
     （今回発生したケース。ロジックは正しいが表示メッセージが矛盾していたため下記10で修正）
   - TC-U3: ローカルと registry が同一バージョン → `Already on latest version` メッセージ
   - TC-U4: registry 取得失敗（ネットワーク等）→ 手動コマンド案内・exit 1
   - TC-U5: stable ローカルでは candidate が新しくても自動更新しない
   - TC-U6: prerelease ローカルでは candidate/latest のより新しい方へ進む
   - TC-U7: `latest` 取得成功・`candidate` 取得失敗時は latest 判定で継続
   - TC-U8: `--dry-run` が実 install せず正しい `npm install -g --prefix` を出す
2. `docs/KNOWN-BUGS.md` の UPDATE-002 記載に、上記スモークテスト未実施だった経緯と
   今回追加したテストケースへの参照を追記する（済）
3. Blocker 1: `copilot-version-watch.yml` の dispatch 呼び出しを新 `npm-package.yml` の
   入力仕様（`publish` / `retag_latest` / `previous_audited_version`）に合わせて修正
4. Blocker 2: `retag-latest.yml` を deprecated fail に変更（`promote-and-publish.yml` と同様の扱い）
5. Blocker 3: manifest を package 内 (`packages/copilot-termux/config/...`) に一本化。
   top-level `config/copilot-termux-release-manifest.json` は削除し、
   `copilot-version-watch.yml` の参照パスを package 内に変更
6. Blocker 4: `check-updates.js` の `compareVersions()` に「`x.y.z-N` 数字固定を前提とする」
   コメントを追加。TC-U6 でこの前提のテストを行う
7. 未コミットの workflow 変更（`npm-package.yml` / `promote-and-publish.yml` /
   `retag-latest-dist-tags.js`）+ 上記 3〜6 の修正をレビューし、コミットする
8. 開発リポジトリの 9 commits + 上記コミットを `origin/main` に push する
   （publish 自体は実行しない。ワークフロー定義の反映のみ）
9. TC-U1〜U8 を実機・ドライラン等で確認する
10. `runUpdate()` の `isPrerelease` 分岐によるメッセージ矛盾を修正（上記「追加発見」参照）。
    `!targetVer` の場合は常に `Already on latest version: ${currentVersion}` を表示するよう統一する

## 対象外（次のフェーズ・ユーザー承認が別途必要）

- 実際の `npm publish`（candidate タグでの 1.0.65-1 公開、または 1.0.66 へのバンプ）
- npm 上の孤立バージョン `1.0.65` の扱い

## codex（gpt-5.5）STEP8レビュー結果（2026-07-02・実施記録）

### 1回目（上記「1回目」欄と同一・本セクションから参照用）
判定: Conditional Go（Blocker 4件、上記参照）

### 2回目（`a1432ad..71fd4fc` 差分、push後に再確認）
判定: **Conditional Go**（npm release/promotion 実行は修正後）

> 補足: 過去のコミットメッセージ（`abf28a7`）に「GPT-5.5コードレビュー Go判定（2回・Blocker解消確認済み）」と記載されていたが、
> この2回目レビューの記録が本ドキュメントに存在しなかったため、2026-07-02 に改めて独立実行して検証した。
> 結果、`check-updates.js` の rollback 誤案内バグ修正自体は Go だったが、同一コミットに含まれる
> workflow/manifest 変更に未解消の指摘が3件（中2・低1）残っていたことが判明した。

**Findings（3件）**:
1. 🟡中: `npm-package.yml` が manifest の `candidate_state`/`last_updated` を更新しなくなったが、runbook は「自動更新される」と記載したまま
2. 🟡中: retag 後に manifest `latest_candidate_version` が古い値のまま残り、次回 retag で registry と食い違う
3. 🟢低: `release-runbook.md` Step 6 の retag 期待値の記載例が実装と矛盾

### 3回目（上記3件の修正後、再レビュー）
判定: **Go**（Findings なし）

- `npm-package.yml` の publish/retag 両ステップで `candidate_state`/`last_updated` を更新するよう修正 → 指摘1解消
- retag ステップで `npm view <package> dist-tags.candidate` により retag 後の実際の registry 状態を取得し `latest_candidate_version` に反映するよう修正 → 指摘2解消
- `release-runbook.md` Step 6 の期待値・manifest自動更新の説明を実装に合わせて修正 → 指摘3解消
- 残余リスク（Non-blocker）: `npm view dist-tags.candidate` の実 registry 上でのライブ挙動はこの場では未検証（実際の retag 実行時に確認要）
