# Known Bugs

## npm-package.yml: 遡及G1レビューでNo-Go(8件のBlocker、2026-09-13)

**背景**: issue #35で判明した「全ワークフローファイルが2026-06-16に一括でmainへ直接pushされ、
2026-07-17のゲート導入より前に作成されたまま一度もG1相当の設計レビューを経ていない」問題への対応。
ユーザー判断により、実際にnpm publish・npmトークンを扱う根幹ロジックから遡及レビューを開始。

`promote-and-publish.yml`・`retag-latest.yml`は中身確認済み、いずれも`DEPRECATED`として
即座にexit 1するだけの空ファイルで実害なしと判定(レビュー対象外)。

実際に稼働している唯一のnpm publishワークフロー`npm-package.yml`をGPT-5.6-terraでG1相当レビューした結果、
**No-Go(Blocker 8件)**。

### Blocker一覧(review_out_copilot_workflows_g1.txt参照)

1. **コマンドインジェクション**: `${{ inputs.previous_audited_version }}`をnpm-package.yml:213・261で
   シェルに直接埋め込んでいる。引用符・改行・シェル演算子を含む入力がシェル構文として解釈される。
   261行目は`GH_TOKEN: ${{ github.token }}`(contents:write, pull-requests:write権限)が有効な
   コンテキストで発生するため、任意操作につながる。
2. **任意refでのworkflow_dispatch**: `github.ref == 'refs/heads/main'`の制約がなく、`actions/checkout`も
   明示ref固定なし。手動実行時に任意ブランチの内容をnpm publishできてしまう。
3. **NPM_TOKENと書込み可能GITHUB_TOKENの混在**: publish job全体にcontents:write・pull-requests:writeが
   付与された状態でNPM_TOKENも渡している。侵害時に両方の権限が同時に露出する。
4. **RELEASE_ADMIN_PATの権限過大**: docs/operations/release-runbook.mdの指示がclassic PAT
   (repo, workflowスコープ)で、対象リポジトリに限定されない。fine-grained PAT/GitHub Appへの
   切り替えを推奨。
5. **retagロールバックが非原子的**: retag-latest-dist-tags.jsのrestoreTags()が、latest/candidateの
   復元を別々に行い、片方失敗時に握り潰してしまう(ログのみ)。
6. **retag対象の監査済み検証不足**: previous_audited_versionが空でないことしか検証せず、
   manifest.latest_audited_versionとの一致確認がない。
7. **admin merge前のPR内容再検証不足**: 既存branch/PR再利用時、差分がmanifest許可フィールドのみか・
   値がregistry実測値と一致するかを確認せずadmin mergeする。
8. **mutable action tag使用**: `actions/checkout@v4`・`actions/setup-node@v4`が高権限ジョブで
   SHA固定されていない。

### 対応状況

- Blocker 1(コマンドインジェクション)・Blocker 2(任意ref publish): **修正完了**(commit 85c8ac9, PR#91, 2026-09-13)。
  G1(review_out_copilot_g1_fix_v1.txt)・G3(review_out_copilot_g3.txt)ともGo。
- Blocker 5(retagロールバック非原子的)・Blocker 6(監査済み版検証不足)・Blocker 7(PR内容再検証不足)・
  Blocker 8(mutable action tag): **修正完了**(commit d15a0e6, PR#93, 2026-09-13)。
  G1はv1〜v4の4回のやり取りを経てGo(review_out_copilot_g1_fix_v4.txt)、
  Blocker7はG3で追加指摘を受けさらに強化(review_out_copilot_g3_blocker7_v2.txtで最終Go)。
  retag-latest-dist-tags.jsのrestoreTags()を依存性注入・戻り値ベースに変更、新規テスト
  scripts/retag-latest-dist-tags.test.js追加。admin merge前にPR head時点のmanifestを
  origin/mainと比較し、許可フィールド以外の変更を拒否するロジックを追加(publish/retag両方)。
- Blocker 3(NPM_TOKENと書込み可能GITHUB_TOKENの混在、job権限分離): **未着手**。設計規模が大きい
  (publish jobをnpm-publish専用jobとmanifest更新専用jobに分割する必要がある)ため後続タスクとして
  保留。
- Blocker 4(RELEASE_ADMIN_PATの権限過大): **未着手**。コード変更では完結せず、fine-grained PAT/
  GitHub Appへの切り替えというユーザー側のGitHub UI操作が必要。

### 経緯・関連

- issue #35(bash0816/Github-Copilot-Termux-Private)
- 遡及レビュー方針決定: ユーザーが「全6ファイルを遡及レビュー」を選択(2026-09-13)

## issue #32・#34修正時にスコープ外とした事項(2026-09-14、先送りであり解決済みではない)

issue #32(retag_latest必須パラメータ検証タイミング)・issue #34(npm latest昇格後の
release-finalize.yml自動dispatch欠落)の修正(commit 1fa46a3・PR#95によるissue #34修正時、
G3レビュー[Claude Opus 5、terra週間制限フォールバック]で以下がNon-blockerとして指摘された。
**Non-blocker=バグではないという意味ではなく、今回のスコープでは対応しきれなかった項目**:

1. **release-finalize.ymlのPRタイトル`[copilot-manifest]`プレフィックスとnpm-package.ymlの
   "他にopenなmanifest-write PRがあればエラー"ガードの潜在的結合**: release-finalize.ymlが
   途中失敗してRELEASES.md用PRをopenのまま残すと、次回リリースのnpm-package.yml内
   manifest更新ステップがブロックされる。手動dispatch時代から存在した結合だが、
   自動化(issue #34対応)により失敗が気づかれにくくなる分リスクが上がった。
   実害: 現時点でopen PRは0件、未発生。次回リリースで異常終了があれば要注意。

2. **docs/operations/release-runbook.md:318のSTEP 7が未更新**: 「GitHub Release作成(手動)」
   という記述のまま、手動`gh workflow run release-finalize.yml`の実行例が残っている。
   issue #34対応で自動dispatchされるようになったため、記述を更新する必要がある。
   実害: ドキュメントが実態と乖離しているだけで、機能的な実害はない。

3. **already_retagged再実行経路でのリカバリ未対応(issue #34対応の対象外)**: 既にlatest昇格済み
   だがrelease-finalize未実施のまま放置された版に対し、npm-package.ymlを再実行しても
   `last_updated`が当日と同じ場合`git diff --staged --quiet`が真になりPR作成がスキップされ、
   結果としてDispatch release-finalizeステップまで到達しない。
   実害: 自動dispatchが何らかの理由で失敗した場合、npm-package.ymlの再実行では復旧できず、
   従来通り`gh workflow run release-finalize.yml`の手動実行が必要(現状と同じ、退行ではない)。
