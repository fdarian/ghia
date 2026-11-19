---
"@ghia/native": minor
---

The clipboard carries several types. `writeClipboard(items)` and `readClipboard()` on the renderer replace `writeClipboardText` and `readClipboardText`: `text/plain`, `text/html` and `text/uri-list` use their pasteboard types, and every other type, such as `application/x-lexical-editor`, goes into Chrome's `org.chromium.web-custom-data` entry, so a page here and a page in Chrome exchange them. `navigator.clipboard.writeText` and `readText` run on top, and the test renderer holds the entries in memory.
