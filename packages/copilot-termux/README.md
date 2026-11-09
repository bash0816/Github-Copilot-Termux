# @bash0816/copilot-termux

GitHub Copilot CLI for Termux (Android aarch64).

Termux (Android aarch64) 向け GitHub Copilot CLI パッケージです。

## Status / 状態

- Latest published versions: see the npm dist-tags (`npm view @bash0816/copilot-termux dist-tags`) / 公開中の最新版は npm の dist-tag を参照してください(`npm view @bash0816/copilot-termux dist-tags`)
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

- Run `copilot update`. It installs the newest audited package and then runs `copilot-termux setup` for you. / `copilot update` を実行します。監査済みの最新パッケージを入れ、続けて `copilot-termux setup` を自動で実行します。
- If you installed with `npm install -g` yourself, run `copilot-termux setup` afterwards. The same applies when `copilot` prints "copilot <version> is not set up". / `npm install -g` で直接入れた場合は、その後 `copilot-termux setup` を実行してください。「copilot <version> is not set up」と表示された場合も同じです。

```sh
npm install -g @bash0816/copilot-termux@latest --force
copilot-termux setup
```

- This package runs the copilot version listed in its manifest and turns off the upstream CLI's own auto-update (`COPILOT_AUTO_UPDATE=false`). The version you run is the version that was tested. / このパッケージは manifest に書かれた版の copilot を実行し、上流 CLI の自己更新を無効にしています(`COPILOT_AUTO_UPDATE=false`)。実行される版は検証済みの版です。
- `node` is required to start `copilot` (the launcher reads the manifest with it). / `copilot` の起動に `node` が必要です(起動時に manifest を読み取るため)。
- Do not run `copilot-termux setup` several times at the same time. If a setup was interrupted, or `copilot` fails to start after it, fix the cause (network, glibc) and run `copilot-termux setup` again. If that does not help, delete `~/.copilot-termux/<version>` and run it once more. / `copilot-termux setup` を同時に複数実行しないでください。setup が中断した場合や、setup の後に `copilot` が起動しない場合は、原因(ネットワーク、glibc など)を直して `copilot-termux setup` を再実行してください。それでも直らないときは `~/.copilot-termux/<version>` を削除してもう一度実行してください。

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

- **1.0.75+: bionic フォールバック経路でクラッシュする既知の問題があります。** glibc のセットアップが未完了/不十分な状態ではこの経路に入り、`copilot` がクラッシュして起動できません。**回避策**: `pkg install glibc-repo && pkg install glibc` を実施し、glibc modeで実行してください。

- **1.0.76のCAPI rename検知修正**（`BIONIC_SIGSEGV_STUB_GROUPS`）により、以前は該当exportが見つからずfail-safeで早期停止していたbionicフォールバック経路が、この既知のSIGSEGVそのものへ到達するようになりました。これはrename修正自体の回帰ではありません。

## License / ライセンス

- Wrapper code: GPL-3.0-only
- `@github/copilot` CLI: [GitHub Copilot CLI License](https://github.com/github/copilot-cli/blob/main/LICENSE.md)
- PTY module (`pty.node`): MIT
