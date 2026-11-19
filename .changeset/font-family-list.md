---
"@ghia/native": patch
---

`font-family` is a list, as in CSS: the first installed family draws, the installed ones after it are the fallbacks for the glyphs it lacks, and `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`, `serif`, `monospace`, `cursive`, `fantasy` and `math` map to what Chrome uses on macOS. A web font stack no longer falls through to GPUI's fallback face. `<code>` takes the list too. A focused `contenteditable` host dims no other focusable element, as a text field does not.
