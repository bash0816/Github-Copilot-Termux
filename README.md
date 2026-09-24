# Copilot-Termux

GitHub Copilot CLI for Termux (Android aarch64).

Termux (Android aarch64) 向け GitHub Copilot CLI パッケージです。

## Status / 状態

- **@latest**: `1.0.82`（recommended / 推奨）
- package: `@bash0816/copilot-termux`
- `copilot -p`: **available** ✅（1.0.82、glibc mode）
- TUI (`copilot`): **available** ✅（1.0.82、glibc mode）
- MCP: **available** ✅（1.0.82、glibc mode）

既知の問題は [Known Issues](#known-issues--既知の問題) 参照。

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

`@bash0816/copilot-termux` は `@github/copilot` CLI の Termux 向けラッパーです。glibc ローダーを
使用して、標準的な glibc ベースの Copilot バイナリを Android 上で直接実行します。

## Known Issues / 既知の問題

- **1.0.75+: bionic フォールバック経路でクラッシュする既知の問題があります。** 本パッケージは
  [Requirements](#requirements--必要環境) の glibc を正しくセットアップして使うことを前提としています。
  glibc のセットアップが未完了/不十分な状態のまま実行すると bionic フォールバック経路に入り、
  1.0.75 以降ではこの経路で `copilot` がクラッシュして起動できません。**回避策**: 上記
  [Requirements](#requirements--必要環境) の通り `pkg install glibc-repo && pkg install glibc` を
  実施し、glibc mode で実行してください（glibc mode では本問題は発生しません）。調査中です。

- **1.0.76のCAPI rename検知修正**（`BIONIC_SIGSEGV_STUB_GROUPS`）により、以前は該当exportが見つからずfail-safeで早期停止していたbionicフォールバック経路が、この既知のSIGSEGVそのものへ到達するようになりました。これはrename修正自体の回帰ではありません。

## Do Not Use / 非推奨

`@github/copilot` を Termux に直接インストールしないでください。bionic 非互換で動作しません。

## License / ライセンス

- Wrapper code (`packages/copilot-termux/`): GPL-3.0-only
- `@github/copilot` CLI: [GitHub Copilot CLI License](https://github.com/github/copilot-cli/blob/main/LICENSE.md)（独自ライセンス・再配布条件あり）
