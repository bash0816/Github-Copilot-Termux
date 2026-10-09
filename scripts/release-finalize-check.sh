#!/usr/bin/env bash
# release-finalize の事前検証（副作用なし: タグ・Release・ファイル書き込みは行わない）
#
# 入力（環境変数）:
#   VER              必須 対象バージョン
#   PKG_NAME         必須 npm パッケージ名
#   REPO             必須 owner/repo
#   SOURCE_SHA_INPUT 任意 配布元 SHA（指定時は npm gitHead と完全一致を要求）
# 出力: GITHUB_OUTPUT（未設定時は標準出力）に source_sha / state_sha / tag_state
set -euo pipefail

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

# JSON 文字列($1) からキー($2) の値を取り出す。キーが無ければ非ゼロ終了。
json_get() {
  printf '%s' "$1" | node -e "
    const o = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const v = o[process.argv[1]];
    if (v === undefined || v === null) process.exit(2);
    process.stdout.write(String(v));
  " "$2"
}

: "${VER:?VER is required}"
: "${PKG_NAME:?PKG_NAME is required}"
: "${REPO:?REPO is required}"
SOURCE_SHA_INPUT="${SOURCE_SHA_INPUT:-}"

VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9a-zA-Z.]+)?(\.[0-9]+)?$'
SHA_RE='^[0-9a-f]{40}$'
[[ $VER =~ $VERSION_RE ]] || fail "invalid version format: ${VER}"

MANIFEST_PATH="packages/copilot-termux/config/copilot-termux-release-manifest.json"
PKG_JSON_PATH="packages/copilot-termux/package.json"

# a. 配布元 SHA: npm 上の gitHead を正とする
echo "== a. npm gitHead of ${PKG_NAME}@${VER}"
npm_head=$(npm view "${PKG_NAME}@${VER}" gitHead 2>/dev/null) \
  || fail "npm view gitHead failed for ${PKG_NAME}@${VER}"
[[ $npm_head =~ $SHA_RE ]] || fail "npm gitHead is missing or invalid: '${npm_head}'"
source_sha="$npm_head"
echo "   gitHead=${source_sha}"

# b. 任意入力 source_sha は gitHead と完全一致を要求
if [ -n "$SOURCE_SHA_INPUT" ]; then
  echo "== b. source_sha input check"
  [ "$SOURCE_SHA_INPUT" = "$npm_head" ] \
    || fail "source_sha input (${SOURCE_SHA_INPUT}) != npm gitHead (${npm_head})"
fi

# c. 状態の基準コミット: 実行時点の origin/main を固定して記録
echo "== c. fetch origin main"
git fetch origin main || fail "git fetch origin main failed"
state_sha=$(git rev-parse origin/main) || fail "cannot resolve origin/main"
[[ $state_sha =~ $SHA_RE ]] || fail "origin/main is not a commit SHA: '${state_sha}'"
echo "   state_sha=${state_sha}"

# d. 配布元が origin/main の祖先であること
echo "== d. source is ancestor of state"
git cat-file -e "${source_sha}^{commit}" 2>/dev/null \
  || fail "source commit ${source_sha} not found in repository"
if ! git merge-base --is-ancestor "$source_sha" "$state_sha"; then
  fail "source ${source_sha} is not an ancestor of origin/main ${state_sha}"
fi

# e. 配布元 package.json の version == VER
echo "== e. source package.json version"
pkg_json=$(git show "${source_sha}:${PKG_JSON_PATH}") \
  || fail "cannot read ${PKG_JSON_PATH} at source ${source_sha}"
pkg_version=$(json_get "$pkg_json" version) \
  || fail "cannot read version from source package.json"
[ "$pkg_version" = "$VER" ] \
  || fail "source package.json version (${pkg_version}) != VER (${VER})"

# f. 状態の manifest（state_sha 基準）: audited == VER かつ promoted
echo "== f. state manifest (at ${state_sha})"
manifest_json=$(git show "${state_sha}:${MANIFEST_PATH}") \
  || fail "cannot read ${MANIFEST_PATH} at state ${state_sha}"
audited=$(json_get "$manifest_json" latest_audited_version) \
  || fail "manifest has no latest_audited_version"
[ "$audited" = "$VER" ] \
  || fail "manifest latest_audited_version (${audited}) != VER (${VER})"
candidate_state=$(json_get "$manifest_json" candidate_state) \
  || fail "manifest has no candidate_state"
[ "$candidate_state" = "promoted" ] \
  || fail "manifest candidate_state (${candidate_state}) != 'promoted'"

# g. npm dist-tags.latest == VER
echo "== g. npm dist-tags.latest"
npm_latest=$(npm view "$PKG_NAME" dist-tags.latest 2>/dev/null) \
  || fail "npm view dist-tags.latest failed for ${PKG_NAME}"
[ "$npm_latest" = "$VER" ] \
  || fail "dist-tags.latest=${npm_latest}, expected ${VER}"

# h. タグ解決（annotated は peeled 行、lightweight は直接行を採用）
echo "== h. remote tag v${VER}"
ls_out=$(git ls-remote --tags origin "refs/tags/v${VER}" "refs/tags/v${VER}^{}") \
  || fail "git ls-remote failed (cannot determine tag state, not treating as absent)"
tag_direct=""
tag_peeled=""
while IFS=$'\t' read -r sha ref; do
  case "$ref" in
    "refs/tags/v${VER}") tag_direct="$sha" ;;
    "refs/tags/v${VER}^{}") tag_peeled="$sha" ;;
  esac
done <<< "$ls_out"

tag_commit=""
if [ -z "$ls_out" ]; then
  tag_state="absent"
elif [ -z "$tag_direct" ] && [ -z "$tag_peeled" ]; then
  fail "unexpected git ls-remote output for v${VER}: ${ls_out}"
else
  if [ -n "$tag_peeled" ]; then
    tag_commit="$tag_peeled"
  else
    tag_commit="$tag_direct"
  fi
  [[ $tag_commit =~ $SHA_RE ]] || fail "tag v${VER} resolved to invalid commit: '${tag_commit}'"
  if [ "$tag_commit" = "$source_sha" ]; then
    tag_state="match"
  else
    tag_state="mismatch"
  fi
fi
echo "   tag_state=${tag_state} tag_commit=${tag_commit:-none}"

# i. 出力
emit() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"
  else
    printf '%s=%s\n' "$1" "$2"
  fi
}
if [ "$tag_state" = "mismatch" ]; then
  fail "tag v${VER} points to ${tag_commit}, not source ${source_sha}; not moving it"
fi

emit source_sha "$source_sha"
emit state_sha "$state_sha"
emit tag_state "$tag_state"

echo "Release readiness verified: ${VER} (source=${source_sha}, tag_state=${tag_state})"
