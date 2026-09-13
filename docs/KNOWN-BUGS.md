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

未着手。修正はユーザー合意の優先順位に従って段階的に実施予定。

### 経緯・関連

- issue #35(bash0816/Github-Copilot-Termux-Private)
- 遡及レビュー方針決定: ユーザーが「全6ファイルを遡及レビュー」を選択(2026-09-13)
