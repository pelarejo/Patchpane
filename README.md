# Patchpane

Review Git changes in a clean, local HTML page. Patchpane brings side-by-side
diffs and focused change highlighting to your terminal workflow, with everything
contained in one file that works offline.

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
node --test tests/viewer.test.cjs   # Node is only needed for these viewer tests
cargo build --release
```

`src/main.rs` runs Git and combines NUL-delimited numstat with its matching patch.
`src/viewer.js` parses hunks on demand and builds the DOM using text nodes.
`src/page.html` and `src/style.css` are embedded at compile time.

Licensed under [MIT](LICENSE).
