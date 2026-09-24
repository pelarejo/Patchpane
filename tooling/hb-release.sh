#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: $0 (uses the version in Cargo.toml)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
cargo check

if [[ -n "$(git status --porcelain -- Cargo.lock)" ]]; then
  echo "Cargo.lock has uncommitted changes. Commit the lockfile and rerun the release script; no tag was created." >&2
  exit 1
fi

version=$(awk -F '"' '
  /^\[package\]/ { package = 1; next }
  /^\[/ { package = 0 }
  package && /^[[:space:]]*version[[:space:]]*=/ { print $2; exit }
' Cargo.toml)
: "${version:?Could not read package version from Cargo.toml}"
tag="v${version}"

if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "Tag $tag already exists locally" >&2
  exit 1
fi
remote_tag=$(git ls-remote --tags origin "refs/tags/$tag")
if [[ -n "$remote_tag" ]]; then
  echo "Tag $tag already exists on origin" >&2
  exit 1
fi

url="https://github.com/pelarejo/Patchpane/archive/refs/tags/${tag}.tar.gz"

git tag -- "$tag"
git push origin "refs/tags/$tag"

archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
curl --fail --location --retry 3 --output "$archive" "$url"
sha256=$(shasum -a 256 "$archive" | awk '{print $1}')

printf '\nurl "%s"\nsha256 "%s"\n' "$url" "$sha256"
