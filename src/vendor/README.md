# Highlight.js

Pinned common-language browser bundle: 11.12.0, BSD-3-Clause.

- Bundle: https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.12.0/highlight.min.js
- License: https://raw.githubusercontent.com/highlightjs/highlight.js/11.12.0/LICENSE

Both files are embedded in reports. The renderer escapes the bundle's `<!--`
regex literal as `\x3c!--` to avoid HTML script-parser state transitions.
After updating, run the viewer tests, including embedded-bundle checks.
