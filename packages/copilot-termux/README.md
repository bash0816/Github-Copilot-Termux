# @bash0816/copilot-termux

GitHub Copilot CLI wrapper for Termux (Android aarch64).

## Bundled Software

This package includes @github/copilot distributed in unmodified form under the GitHub Copilot CLI License (lib/copilot/LICENSE.md).

## Requirements

- Android aarch64 (Termux)
- Either `MAGI_NODE=/path/to/glibc-node-v24+` or bundled `lib/node` + `lib/glibc/`

## Known Limitations

- `keytar.node` (credential storage) requires `libsecret-1` which is not bundled. Authentication via `GITHUB_TOKEN` is recommended.
