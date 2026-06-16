#!/usr/bin/env bash
# Stage @github/copilot and glibc Node.js into packages/copilot-termux/lib/
# Usage: bash scripts/stage-copilot.sh --copilot-version X.Y.Z --node-artifact PATH --glibc-dir PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LIB_DIR="$REPO_DIR/packages/copilot-termux/lib"

COPILOT_VERSION=""
NODE_ARTIFACT=""
GLIBC_DIR=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --copilot-version) COPILOT_VERSION="$2"; shift 2 ;;
    --node-artifact)   NODE_ARTIFACT="$2"; shift 2 ;;
    --glibc-dir)       GLIBC_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -z "$COPILOT_VERSION" || -z "$NODE_ARTIFACT" || -z "$GLIBC_DIR" ]] && \
  echo "Usage: $0 --copilot-version X.Y.Z --node-artifact PATH --glibc-dir PATH" && exit 1

# 1. Stage @github/copilot (unmodified)
mkdir -p "$LIB_DIR/copilot"
PACK_DIR="$(mktemp -d)"
npm pack "@github/copilot@$COPILOT_VERSION" --pack-destination "$PACK_DIR" > /dev/null
tar -xzf "$PACK_DIR/github-copilot-${COPILOT_VERSION}.tgz" -C "$PACK_DIR"
cp -r "$PACK_DIR/package/." "$LIB_DIR/copilot/"
echo "Staged @github/copilot@$COPILOT_VERSION"

# 2. Stage glibc Node.js binary
cp "$NODE_ARTIFACT" "$LIB_DIR/node"
chmod +x "$LIB_DIR/node"
echo "Staged node binary: $NODE_ARTIFACT"

# 3. Stage glibc .so files
mkdir -p "$LIB_DIR/glibc"
for lib in ld-linux-aarch64.so.1 libc.so.6 libm.so.6 libdl.so.2 libpthread.so.0 \
           librt.so.1 libutil.so.1 libresolv.so.2 libstdc++.so.6 libgcc_s.so.1; do
  if [[ -f "$GLIBC_DIR/$lib" ]]; then
    cp "$GLIBC_DIR/$lib" "$LIB_DIR/glibc/"
    echo "  glibc: $lib"
  else
    echo "  WARN: $lib not found in $GLIBC_DIR"
  fi
done

echo "Stage complete: $LIB_DIR"
