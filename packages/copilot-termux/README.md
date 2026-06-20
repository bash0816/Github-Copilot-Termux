# @bash0816/copilot-termux

GitHub Copilot CLI wrapper for Termux (Android aarch64).

## Requirements

- Android aarch64 (Termux)
- Termux bionic Node.js v24+ (`pkg install nodejs`)
- Termux clang (`pkg install clang`) — required to run `stage-copilot.sh`

## Setup

Run the staging script to download @github/copilot and compile the bionic
compatibility layer:

```sh
./scripts/stage-copilot.sh --copilot-version 1.0.63
```

Then launch with:

```sh
MAGI_NODE=$(which node) copilot --help
```

## Authentication

Use the `GITHUB_TOKEN` environment variable. The `keytar.node` credential
store is not available on Termux aarch64.

## Known Limitations

- `computer.node` (screenshot/computer-use feature) has no linuxmusl-arm64
  variant and is not available.
- The bundled glibc Node.js path (`--node-artifact` / `--glibc-dir`) is
  available for staging but does not work on Android due to seccomp blocking
  `set_robust_list` and `rseq` system calls.

## TUI Support

TUI interactive mode is now available via the bundled native `pty.node`
(compiled for Android aarch64 bionic). Use the `copilot` command with
`--prompt-type mode:tui` or any interactive mode flag.

## Bundled Software

This package includes @github/copilot distributed in unmodified form under
the GitHub Copilot CLI License (lib/copilot/LICENSE.md).
