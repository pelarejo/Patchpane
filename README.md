# Patchpane

Generate a self-contained, offline HTML review of Git changes. Rust CLI, no
crate dependencies; Git is the only runtime dependency. Embedded CSS and
JavaScript, no server, CDN, or network requests.

```sh
cargo install --path .
patchpane                         # unstaged tracked changes; opens browser
patchpane .                       # restrict to the current directory
patchpane --include-untracked .   # also show non-ignored new files
patchpane --staged                # index vs HEAD (also works before first commit)
patchpane main...HEAD             # merge-base comparison
patchpane HEAD~3 HEAD -- src/      # two revisions, restricted to paths
patchpane -C /path/to/repo --context 8
patchpane --no-open -o review.html
patchpane HEAD -o - > review.html  # stdout never opens browser
```

Without `-o`, output goes to a unique HTML file in `$PWD/patchpane/`, created
automatically. `-C` changes the Git repository, not the output directory. Named output files
must not already exist. Files are owner-readable/writable on Unix. HTML embeds
the selected patch, so treat it like source code when sharing it.

Split/unified views, line numbers, file filtering, viewed markers, collapsible
files, line wrapping, and system light/dark theme. Files render near the viewport;
large files load 400 rows at a time. Full patch data stays embedded in the HTML.
Viewed markers last until reload. Replacement lines are paired by position.

Untracked files are excluded by default. `--include-untracked` appends current
untracked files as additions, respects ignore rules and path filters, and leaves
the index unchanged. It can also accompany staged or revision comparisons; those
extra files always come from the current working tree. Nested untracked repositories
are skipped. Binary changes and file modes
are shown as metadata. Non-UTF-8 text is displayed with replacement characters.
No syntax highlighting, comments, or context expansion beyond `--context`.
Memory use scales with patch size; rendering is incremental, ingestion is not.

## Project configuration

Add `.patchpane` at the Git repository root (Git config syntax):

```ini
[patchpane]
    open = false
    include-untracked = true
    staged = false
    context = 8
    output-dir = reviews
```

Precedence: CLI arguments → project config → built-in defaults. The same config
is found from subdirectories or with `-C`; no global or parent-project config is
loaded. Revisions, path filters, and the repository are selected on the CLI.

All supported keys appear above, plus `output` for a fixed filename or `-` for
stdout. Choose either `output` or `output-dir`. Relative config paths resolve
from the repository root; CLI output paths resolve from `$PWD`. Without either,
output still goes to `$PWD/patchpane/`. Existing files are never overwritten.
Add your report directory to `.gitignore` when using `include-untracked`.

Override booleans with `--open` / `--no-open`, `--staged` / `--unstaged`, and
`--include-untracked` / `--no-include-untracked`. Use `--output-dir DIR` for unique
reports or `-o FILE` for a fixed file; either overrides the configured output
setting. `--no-config` skips configuration entirely. Unknown or duplicate keys,
invalid values, and malformed config produce errors; config includes are unsupported.

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
