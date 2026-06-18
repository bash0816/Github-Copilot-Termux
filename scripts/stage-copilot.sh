#!/usr/bin/env bash
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
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

[[ -z "$COPILOT_VERSION" ]] && \
  { echo "Usage: $0 --copilot-version X.Y.Z [--node-artifact PATH --glibc-dir PATH]" >&2; exit 1; }
if [[ ! "$COPILOT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: --copilot-version must be X.Y.Z (e.g., 1.0.0)" >&2; exit 1
fi
if [[ -n "$NODE_ARTIFACT" && -z "$GLIBC_DIR" ]] || \
   [[ -z "$NODE_ARTIFACT" && -n "$GLIBC_DIR" ]]; then
  echo "Error: --node-artifact and --glibc-dir must be specified together" >&2; exit 1
fi
[[ -n "$NODE_ARTIFACT" && ! -f "$NODE_ARTIFACT" ]] && \
  { echo "Error: node artifact not found: $NODE_ARTIFACT" >&2; exit 1; }
[[ -n "$GLIBC_DIR" && ! -d "$GLIBC_DIR" ]] && \
  { echo "Error: glibc dir not found: $GLIBC_DIR" >&2; exit 1; }

PACK_DIR="$(mktemp -d)"
STAGING_DIR="$LIB_DIR/copilot.staging.$$"
BACKUP_DIR="$LIB_DIR/copilot.bak.$$"
COPILOT_MOVED=false
STAGING_COMPLETE=false
COMPAT_TMP=""
trap '
  [[ -n "$COMPAT_TMP" ]] && rm -f "$COMPAT_TMP"
  rm -rf "$PACK_DIR" "$STAGING_DIR"
  if ! $STAGING_COMPLETE && $COPILOT_MOVED; then
    rm -rf "$LIB_DIR/copilot"
    if [[ -d "$BACKUP_DIR" ]]; then
      mv "$BACKUP_DIR" "$LIB_DIR/copilot" || \
        echo "WARN: rollback also failed; backup preserved at $BACKUP_DIR" >&2
    fi
  fi
' EXIT

# 0. Compile bionic-compat.so BEFORE any staging changes.
COMPAT_SRC="$REPO_DIR/scripts/bionic-compat.c"
COMPAT_STAGED="$PACK_DIR/bionic-compat.so"
if command -v clang >/dev/null 2>&1; then
  clang -shared -fPIC -o "$COMPAT_STAGED" "$COMPAT_SRC" -lc -ldl || {
    echo "Error: failed to compile bionic-compat.so" >&2; exit 1
  }
  echo "Compiled bionic-compat.so"
else
  echo "Error: clang is required. Install: pkg install clang" >&2; exit 1
fi

# 1. Stage @github/copilot
mkdir -p "$STAGING_DIR"
npm pack "@github/copilot@$COPILOT_VERSION" --pack-destination "$PACK_DIR" > /dev/null
TARBALLS=()
shopt -s nullglob
TARBALLS=("$PACK_DIR"/*.tgz)
shopt -u nullglob
[[ ${#TARBALLS[@]} -gt 0 ]] || { echo "Error: npm pack produced no tarball" >&2; exit 1; }
tar -xzf "${TARBALLS[0]}" -C "$PACK_DIR"
cp -r "$PACK_DIR/package/." "$STAGING_DIR/"
[[ -f "$STAGING_DIR/package.json" ]] || { echo "Error: staged copilot missing package.json" >&2; exit 1; }
# npm pack verifies tarball integrity against registry dist.integrity internally.
# Also confirm the extracted package name and version match expectations.
_PKG_NAME=$(node -e   'try{process.stdout.write(require(process.argv[2]).name||"")}catch(e){}'   "${STAGING_DIR}/package.json" 2>/dev/null)
_PKG_VER=$(node -e   'try{process.stdout.write(require(process.argv[2]).version||"")}catch(e){}'   "${STAGING_DIR}/package.json" 2>/dev/null)
[[ "$_PKG_NAME" == "@github/copilot" ]] || {
  echo "Error: unexpected package name in staged tarball: ${_PKG_NAME}" >&2; exit 1
}
[[ "$_PKG_VER" == "$COPILOT_VERSION" ]] || {
  echo "Error: version mismatch: expected ${COPILOT_VERSION}, got ${_PKG_VER}" >&2; exit 1
}
echo "Verified: ${_PKG_NAME}@${_PKG_VER}"

if [[ -d "$LIB_DIR/copilot" ]]; then
  mv "$LIB_DIR/copilot" "$BACKUP_DIR"
fi
if mv "$STAGING_DIR" "$LIB_DIR/copilot"; then
  COPILOT_MOVED=true
else
  if [[ -d "$BACKUP_DIR" ]]; then
    mv "$BACKUP_DIR" "$LIB_DIR/copilot" || \
      echo "WARN: rollback also failed; backup preserved at $BACKUP_DIR" >&2
  fi
  echo "Error: failed to install staged copilot" >&2; exit 1
fi
echo "Staged @github/copilot@$COPILOT_VERSION"

# 2. Stage glibc Node.js binary (optional)
if [[ -n "$NODE_ARTIFACT" ]]; then
  cp "$NODE_ARTIFACT" "$LIB_DIR/node"
  chmod +x "$LIB_DIR/node"
  echo "Staged node binary: $NODE_ARTIFACT"
fi

# 3. Stage glibc .so files (optional)
if [[ -n "$GLIBC_DIR" ]]; then
  mkdir -p "$LIB_DIR/glibc"
  if [[ -f "$GLIBC_DIR/ld-linux-aarch64.so.1" ]]; then
    cp "$GLIBC_DIR/ld-linux-aarch64.so.1" "$LIB_DIR/glibc/"
    echo "  glibc [required]: ld-linux-aarch64.so.1"
  else
    echo "Error: ld-linux-aarch64.so.1 not found in $GLIBC_DIR" >&2; exit 1
  fi
  if command -v readelf >/dev/null 2>&1; then
    READELF_OUT=$(readelf -d "$NODE_ARTIFACT") || {
      echo "Error: readelf failed on $NODE_ARTIFACT" >&2; exit 1
    }
    NEEDED_LIBS=()
    while IFS= read -r lib; do
      [[ -z "$lib" ]] && continue
      NEEDED_LIBS+=("$lib")
    done < <(echo "$READELF_OUT" | awk '/NEEDED/{gsub(/[\[\]]/,""); print $NF}')
    [[ ${#NEEDED_LIBS[@]} -gt 0 ]] || {
      echo "Error: readelf found 0 NEEDED libs in $NODE_ARTIFACT (expected glibc deps)" >&2
      exit 1
    }
    for lib in "${NEEDED_LIBS[@]}"; do
      if [[ -f "$GLIBC_DIR/$lib" ]]; then
        cp "$GLIBC_DIR/$lib" "$LIB_DIR/glibc/"
        echo "  glibc [needed]: $lib"
      else
        echo "Error: NEEDED lib not found in glibc dir: $lib" >&2
        exit 1
      fi
    done
  else
    echo "Error: readelf is required but not found. Install binutils." >&2
    exit 1
  fi
fi

# 4. Install bionic-compat.so atomically (temp -> mv, same FS)
COMPAT_TMP="$LIB_DIR/bionic-compat.so.staging.$$"
cp "$COMPAT_STAGED" "$COMPAT_TMP"
mv "$COMPAT_TMP" "$LIB_DIR/bionic-compat.so"
COMPAT_TMP=""
echo "Staged bionic-compat.so"

# All steps succeeded
STAGING_COMPLETE=true
rm -rf "$BACKUP_DIR"
echo "Stage complete: $LIB_DIR"
