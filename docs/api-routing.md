# API ルーティング設計ルール

**このドキュメントを読まずに platform-patch.js のAPI URL部分を触ってはならない。**

---

## 確定している事実（git log + 実測より）

### エンドポイントの役割

| URL | 用途 | Free | Enterprise |
|-----|------|------|-----------|
| `api.githubcopilot.com` | 推論（chat/completions, responses） | ✅ | ❌ 使えない |
| `api.individual.githubcopilot.com` | /models 取得のみ | ✅ | — |
| `COPILOT_API_URL`（Enterprise proxy） | 推論 + /models | — | ✅ |

- **`api.githubcopilot.com` はFree専用の推論URL**（Enterprise に使ってはならない）
- **Enterprise proxy URL で /models を叩くと 421** になる（`ce7199a` 実測）
- **`api.individual` は推論に使えない**（BUG-NEW-2 で判明）

### `COPILOT_API_URL` の値

| アカウント | `COPILOT_API_URL` の値 |
|-----------|----------------------|
| Free | `https://api.individual.githubcopilot.com` |
| Enterprise | Enterprise proxy URL（例: `https://copilot-proxy.githubusercontent.com/...`） |
| 未設定 | （Free・未ログイン状態） |

---

## 正しい実装

### fetchUrl（/models 取得）
```javascript
// api.individual → そのまま使う（Free /models OK）
// Enterprise URL → api.githubcopilot.com に倒す（Enterprise proxy で /models は 421）
// 未設定 → api.githubcopilot.com
const fetchUrl = _selectCapiUrl(process.env.COPILOT_API_URL);
// _selectCapiUrl: api.individual のみ通過、それ以外は api.githubcopilot.com
```

### copilotUrl（推論URL）
```javascript
// Enterprise URL → そのまま使う
// api.individual / 未設定 → api.githubcopilot.com（Free）
const rawApiUrl = process.env.COPILOT_API_URL;
const copilotUrl = (rawApiUrl && !rawApiUrl.includes('api.individual.githubcopilot.com'))
  ? rawApiUrl
  : 'https://api.githubcopilot.com';
```

### authGetCopilotApiUrl（app.js が推論URLとして使う）
```javascript
// null を返すと app.js が models=[] として扱う
// Enterprise → COPILOT_API_URL を返す
// Free / api.individual → api.githubcopilot.com を返す
return process.env.COPILOT_API_URL &&
       !process.env.COPILOT_API_URL.includes('api.individual.githubcopilot.com')
  ? process.env.COPILOT_API_URL
  : 'https://api.githubcopilot.com';
```

---

## 禁止事項

- `copilotUrl = 'https://api.githubcopilot.com'` のハードコード（Enterpriseが壊れる）
- `authGetCopilotApiUrl` から `COPILOT_API_URL` を除去（Enterpriseが壊れる）
- Enterprise URL を `_selectCapiUrl` で弾かずに fetchUrl に使う（421になる）

---

## 変更履歴（壊した経緯）

| コミット | 変更内容 | 影響 |
|---------|---------|------|
| `9444cfe` | `baseUrl = COPILOT_API_URL \|\| api.githubcopilot.com` で fetchUrl・copilotUrl 統一 | Enterprise proxy で /models 421 になる問題が潜在 |
| `ce7199a` | fetchUrl を `api.githubcopilot.com` 固定に変更（Enterprise /models 421 が実測で判明） | fetchUrl 問題は解決 |
| `5e1b2a6` | `_selectCapiUrl` 追加・api.individual 対応 | Free /models 改善 |
| `8c2e5ad` | `copilotUrl = api.githubcopilot.com` 固定に変更 | **Enterprise 推論が壊れた** |
| `851dd47` | `authGetCopilotApiUrl` から `COPILOT_API_URL` を除去 | **Enterprise URL が app.js に渡らなくなった** |

---

## GPT-5.5 レビュー指摘（記録）

### `5e1b2a6`（BUG-NEW-2）時点の指摘
1. `_selectCapiUrl`: 部分一致NG → hostname 完全一致チェック必須（SSRF/token漏洩防止）
2. `copilotUrl` にも individual URL が漏れる → 推論が失敗する
3. stale な `COPILOT_API_URL` がキャッシュ無効化パスで残る → clear 必要

### `b5711f7`（STEP 8）時点の指摘
1. `Copilot-Integration-Id`: `copilot-chat` → `copilot-developer-cli` に修正
2. /v2/token 失敗時の body ログは 500 文字に truncate
3. `napi-known-exports.json` の behavioral_stubs から誤分類エントリを削除
4. KNOWN-BUGS.md の表現修正

### `21c694f`（napi-audit）時点の指摘
- [High] maybeAutoPatch: 失敗時でも config に書き込んでいた → 成功時のみに修正
- [Low] patchApplied が常に true になっていた → 実際の戻り値を使うよう修正
- [Low] GITHUB_OUTPUT heredoc のデリミタをランダム化（injection防止）
