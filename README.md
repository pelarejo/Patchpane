# Patchpane

Review Git changes in a clean, local HTML page. Patchpane brings side-by-side
diffs, syntax coloring, and focused change highlighting to your terminal workflow, with everything
contained in one file that works offline.

**This project was built entirely as an exercise in vibe coding and is provided
as is, without warranty.**

It does, however, make staring at diffs surprisingly pleasant.

## Install

```sh
brew tap pelarejo/tap
brew install pelarejo/tap/patchpane
```

## Usage

```sh
patchpane                         # Working-tree changes
patchpane --staged                # Staged changes
patchpane main...HEAD             # Compare branches
patchpane --include-untracked     # Include new files
```

Patchpane writes `patchpane/report.html` and prints a clickable `file://` link.
Each run replaces the report. Use `--open` to launch it in your browser, or
`patchpane --help` for all options.

## Configuration

Create `.patchpane` at your Git repository root to set project defaults.
See [`.patchpane.example`](.patchpane.example) for all settings.
Command-line arguments take priority over the configuration file.

## Development

```sh
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
node --test tests/viewer.test.cjs   # Node is only needed for tests
node --test tests/release.test.cjs  # Release-script tests (macOS/Linux)
cargo build --release
```

Run `./tooling/hb-release.sh` from a clean `main` checkout for a guided release:
choose a version, run checks, commit the Cargo version, and publish the tag and
archive checksum. It finishes with manual instructions for updating the formula
and publishing bottles in the Homebrew tap repository.
Pass a version directly with `./tooling/hb-release.sh 0.2.0`, or choose `current`
to release the existing Cargo version. Existing tags are rejected before any edits.
Use `./tooling/hb-release.sh --dry-run` (`--dry` also works) to rehearse the prompts
without changing files, running checks, or contacting external services.

`src/main.rs` runs Git and combines NUL-delimited numstat with its matching patch.
`src/viewer.js` parses hunks on demand and builds the DOM using text nodes.
`src/page.html` and `src/style.css` are embedded at compile time.

Licensed under [MIT](LICENSE). Bundled [Highlight.js](https://highlightjs.org/)
is covered by its [BSD 3-Clause license](src/vendor/highlight.LICENSE).
