# CLAUDE.md — copilot-termux 作業ルール

## 調査・ドキュメント化ルール【必須】

**調査したら必ずドキュメント化する。ドキュメントを読んでから調査する。これは省略不可。**

### 手順

1. **作業前**: `docs/` 以下の関連ドキュメントを読む
2. **調査したら即ドキュメント化**: 調査結果・判明した事実・GPT-5.5レビュー指摘を `docs/` に記録する
3. **履歴を確認**: `git log` でコミット経緯を確認し、「なぜこうなったか」をドキュメントに残す
4. **設計変更時**: 変更の根拠・禁止事項・壊した経緯を必ず `docs/` に追記する
5. **次の調査へ**: ドキュメントに残した内容を起点に次を調査する

### ドキュメント置き場

| 種別 | 場所 |
|------|------|
| 設計ルール・禁止事項 | `docs/<テーマ>.md` |
| バグ記録（エンドユーザー向け・症状と再現条件のみ） | `docs/KNOWN-BUGS.md`（public repo。内部実装詳細・未修正の脆弱性詳細は書かない） |
| バグ記録（内部監査・未修正の脆弱性詳細・調査ログ） | `bash0816/Github-Copilot-Termux-Private` の Issue |
| 動作確認手順 | `docs/SMOKE-TEST.md` |
| 操作手順 | `docs/operations/` |

⛔ このリポジトリ（Github-Copilot-Termux）は **public**。新規ドキュメントファイルを作成する前に
`gh repo view bash0816/Github-Copilot-Termux --json visibility` で対象がpublicであることを
再確認し、内容が内部戦略・未修正の脆弱性詳細に該当する場合は必ず上記privateリポジトリのIssueに書く
（2026-09-14: Claude自身がdocs/KNOWN-BUGS.mdにBlocker3・4の詳細を誤って公開した違反の再発防止）。

---

## API ルーティングルール【絶対厳守】

`docs/api-routing.md` を必ず読むこと。要点：

- `api.githubcopilot.com` は **Free専用の推論URL**。Enterpriseに使ってはならない
- Enterprise proxy URL（`COPILOT_API_URL`）で `/models` を叩くと **421**
- `api.individual.githubcopilot.com` は `/models` 取得のみ可能・推論不可

**platform-patch.js のAPI URL部分を触る前に `docs/api-routing.md` を読む。**

---

## GPT-5.5 レビュー記録ルール

- レビューで指摘された内容は即座に `docs/` に記録する
- 「Go」判定でも指摘内容・根拠を残す
- 「No-Go」の場合は修正内容と再レビュー結果も記録する

---

## 禁止事項

- ドキュメントを読まずにコードを触ること
- 調査結果をドキュメント化せずに次の作業に進むこと
- GPT-5.5 レビュー指摘を記録せずに流すこと
- 同じ問題を2回起こすこと（ドキュメントに残っているはず）
