# Copilot-Termux

GitHub Copilot CLI for Termux (Android aarch64).

Termux (Android aarch64) 向け GitHub Copilot CLI パッケージです。

## Status / 状態

- version: `1.0.65` (latest)
- package: `@bash0816/copilot-termux`
- `copilot -p`: **available** ✅
- TUI (`copilot`): **available** ✅
- MCP: **available** ✅

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

なし（Device A・Device B 検証済み）

## Do Not Use / 非推奨

`@github/copilot` を Termux に直接インストールしないでください。bionic 非互換で動作しません。

## License / ライセンス

- Wrapper code (`packages/copilot-termux/`): GPL-3.0-only
- `@github/copilot` CLI: [GitHub Copilot CLI License](https://github.com/github/copilot-cli/blob/main/LICENSE.md)（独自ライセンス・再配布条件あり）
- PTY module (`pty.node`): MIT
