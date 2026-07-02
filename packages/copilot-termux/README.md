# @bash0816/copilot-termux

GitHub Copilot CLI for Termux (Android aarch64).

Termux (Android aarch64) 向け GitHub Copilot CLI パッケージです。

## Status / 状態

- **@latest**: `1.0.65-1`（recommended / 推奨。1.0.65 の TUI login regression・`/update`参照先・起動時通知バナーの問題を修正済み）
- `copilot -p`: **available** ✅（1.0.65-1）
- TUI (`copilot`): **available** ✅（1.0.65-1）
- MCP: **available** ✅（1.0.65-1）

既知の問題:
- `/update` 実行時に表示される changelog が upstream 公式版のまま（実害小・次回対応。詳細は [Known Issues](#known-issues--既知の問題)）

## Install / インストール

```sh
npm install -g @bash0816/copilot-termux
copilot-termux setup
copilot --version
```

## First-time Setup / 初回セットアップ

```sh
# 1. Install
npm install -g @bash0816/copilot-termux

# 2. Download @github/copilot CLI
copilot-termux setup

# 3. Authenticate
copilot auth login

# 4. Verify
copilot --version
```

## Usage / 使い方

```sh
# Non-interactive prompt / 非対話プロンプト
copilot -p "write a hello world script"

# Interactive TUI / 対話型 TUI
copilot
```

## Update / 更新

```sh
npm install -g @bash0816/copilot-termux@latest --force
copilot-termux setup
```

## Requirements / 必要環境

- Termux (Android aarch64)
- Node.js 18+（`pkg install nodejs`）
- glibc（`pkg install glibc-repo && pkg install glibc`）

## How It Works / 仕組み

`@bash0816/copilot-termux` は `@github/copilot` CLI の Termux 向けラッパーです。

- **bionic-compat.so**: Termux bionic 上で動作しない glibc 依存シンボルをスタブ
- **platform-patch.js**: Rust ネイティブモジュールの Android 非対応 API を Node.js で代替
  - `networkFetch*`: MCP SSE transport 用 HTTP ストリーム実装
  - `responsesStreamDrive`: AI レスポンスストリーム処理
  - `modelHttp*`: AI モデル HTTP 呼び出し
- **pty.node**: Termux bionic ネイティブビルドの PTY モジュール

## Known Issues / 既知の問題

- **`/update` changelog**: `/update` 実行時に表示される changelog（更新内容の説明文）が upstream 公式版のまま。実際のインストールコマンドは fork（`@bash0816/copilot-termux`）を正しく指しているため実害はない
- **`/update` changelog**: The changelog text shown when running `/update` still reflects the upstream official release notes. The actual install command it prints already points to this fork, so no incorrect package is installed

## License / ライセンス

- Wrapper code: GPL-3.0-only
- `@github/copilot` CLI: [GitHub Copilot CLI License](https://github.com/github/copilot-cli/blob/main/LICENSE.md)
- PTY module (`pty.node`): MIT
