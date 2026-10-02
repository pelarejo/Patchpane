#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "Usage: $0 [--dry-run] [VERSION]"
  echo "  --dry-run (or --dry): simulate all steps without writes, builds, or network requests."
  echo "Choose a version, run checks, publish a tag, and guide the Homebrew update."
}
dry=false
choice=""
for argument in "$@"; do
  case $argument in
    --help|-h) usage; exit 0 ;;
    --dry-run|--dry) dry=true ;;
    --*) usage >&2; exit 1 ;;
    *) [[ -z $choice ]] || { usage >&2; exit 1; }; choice=$argument ;;
  esac
done
run() {
  if $dry; then
    printf '[dry]'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}
if $dry; then echo "Dry run: all actions and external checks are simulated; nothing will be changed."; fi

cd "$(dirname "$0")/.."
confirm() {
  local answer
  read -r -p "$1 [y/N] " answer || return 1
  [[ $answer == y || $answer == Y || $answer == yes ]]
}
fail() { echo "$*" >&2; exit 1; }

current=$(awk -F '"' '
  /^\[package\]/ { package = 1; next }
  /^\[/ { package = 0 }
  package && /^[[:space:]]*version[[:space:]]*=/ { print $2; exit }
' Cargo.toml)
version_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
[[ $current =~ $version_pattern ]] || fail "Expected a stable X.Y.Z version in Cargo.toml."
IFS=. read -r major minor patch <<< "$current"
printf 'Current version: %s\n' "$current"
if [[ -z $choice ]]; then
  printf '  patch: %s.%s.%s\n  minor: %s.%s.0\n  major: %s.0.0\n' \
    "$major" "$minor" "$((patch + 1))" "$major" "$((minor + 1))" "$((major + 1))"
  read -r -p "Choose patch/minor/major/current, or enter X.Y.Z [patch]: " choice
fi
case ${choice:-patch} in
  patch) version="$major.$minor.$((patch + 1))" ;;
  minor) version="$major.$((minor + 1)).0" ;;
  major) version="$((major + 1)).0.0" ;;
  current) version=$current ;;
  *) version=${choice#v} ;;
esac
[[ $version =~ $version_pattern ]] || fail "Version must be a stable X.Y.Z number."
tag="v$version"

# Reject existing releases before changing files or running builds.
if ! $dry; then
  if git show-ref --verify --quiet "refs/tags/$tag"; then fail "Tag $tag already exists locally."; fi
  remote_tag=$(git ls-remote --tags origin "refs/tags/$tag")
  [[ -z $remote_tag ]] || fail "Tag $tag already exists on origin."
else
  echo "[dry] Would check that $tag does not exist locally or on origin. Do not treat this as release validation."
fi
IFS=. read -r next_major next_minor next_patch <<< "$version"
if (( next_major < major || (next_major == major && next_minor < minor) ||
      (next_major == major && next_minor == minor && next_patch < patch) )); then
  fail "Version must be $current or newer."
fi
if ! $dry; then
  [[ $(git branch --show-current) == main ]] || fail "Switch to main before releasing."
  [[ -z $(git status --porcelain) ]] || fail "Commit or stash local changes before releasing."
  for tool in cargo node curl shasum; do
    command -v "$tool" >/dev/null || fail "Required tool not found: $tool"
  done
else
  echo "[dry] Would require a clean main checkout and cargo, node, curl, and shasum."
fi

echo "Release $tag: update Cargo files, run checks, commit the version, and push main + tag."
confirm "Continue?" || exit 0

work="<temporary directory>"
step="checking origin/main"
if ! $dry; then
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
fi
trap 'printf "\nStopped while %s. Existing commits/tags and file changes are kept; inspect them before retrying.\n" "$step" >&2' ERR

run git fetch origin main
run git merge-base --is-ancestor origin/main HEAD || fail "main is behind or has diverged from origin/main. Update it first."
step="updating the version and running checks"
if [[ $version != "$current" ]]; then
  if $dry; then
    echo "[dry] Would update Cargo.toml and Cargo.lock from $current to $version."
  else
    awk -v version="$version" '
      /^\[package\]/ { package = 1 }
      /^\[/ && !/^\[package\]/ { package = 0 }
      package && /^[[:space:]]*version[[:space:]]*=/ { $0 = "version = \"" version "\"" }
      { print }
    ' Cargo.toml > "$work/Cargo.toml"
    cat "$work/Cargo.toml" > Cargo.toml
  fi
fi
run cargo fmt --check
run cargo clippy --all-targets -- -D warnings
run cargo test --locked
run node --test tests/viewer.test.cjs tests/release.test.cjs
run cargo build --release --locked

run git diff -- Cargo.toml Cargo.lock
if $dry; then echo "[dry] Checks were simulated, not executed."; fi
confirm "Proceed to commit and publish $tag?" || {
  echo "Cancelled. Nothing was published; any version edits from a real run remain for review."
  exit 0
}
step="committing and publishing $tag"
if $dry; then
  if [[ $version != "$current" ]]; then
    run git add Cargo.toml Cargo.lock
    run git commit -m "Release $tag"
  fi
elif ! git diff --quiet -- Cargo.toml Cargo.lock; then
  git add Cargo.toml Cargo.lock
  git commit -m "Release $tag"
fi
run git tag -- "$tag"
run git push --atomic origin main "refs/tags/$tag"

url="https://github.com/pelarejo/Patchpane/archive/refs/tags/${tag}.tar.gz"
step="downloading the published archive ($url)"
run curl --fail --location --retry 5 --retry-delay 2 --retry-all-errors --output "$work/source.tar.gz" "$url"
if $dry; then
  sha256="<archive SHA-256 calculated during a real release>"
  echo "[dry] Would calculate the archive checksum and publish $tag."
else
  sha256=$(shasum -a 256 "$work/source.tar.gz" | awk '{print $1}')
  echo "Published $tag"
fi
printf '\nurl "%s"\nsha256 "%s"\n' "$url" "$sha256"

cat <<'HANDOFF'

Next steps in your pelarejo/homebrew-tap checkout (manual):

1. Start a release branch from an up-to-date main:
   cd /path/to/homebrew-tap
   git switch main
   git pull --ff-only
HANDOFF
printf '   git switch -c patchpane-%s\n' "$version"
cat <<'HANDOFF'

2. Edit Formula/patchpane.rb:
   - Set url and sha256 to the values printed above.
   - Remove the previous bottle block and any revision line.
   - Update an explicit version line if present; keep the head entry.

3. Review the diff, commit the formula, and open a pull request:
   git diff -- Formula/patchpane.rb
   git add Formula/patchpane.rb
HANDOFF
printf '   git commit -m "patchpane %s"\n' "$version"
printf '   git push -u origin patchpane-%s\n' "$version"
cat <<'HANDOFF'
   gh pr create --repo pelarejo/homebrew-tap --base main --fill

4. Wait for the PR checks and bottle builds to pass. In the tap's GitHub Actions,
   run the "brew pr-pull" workflow (publish.yml) with the PR number and its current
   head commit SHA. Let that workflow publish the bottles and update main rather
   than merging the formula PR manually. Check that the workflow succeeds.

5. Once published:
   brew update
   brew upgrade pelarejo/tap/patchpane
HANDOFF

if $dry; then echo "Dry run complete. No files, commits, tags, releases, PRs, or workflows were changed."; fi
