---
"@ghia/native": patch
---

`font-family` is a list, as in CSS: the first installed family draws, and `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`, `serif` and `monospace` map to what Chrome uses on macOS. A web font stack no longer falls through to the bundled sans, which has no bold. A focused `contenteditable` host dims no other focusable element, as a text field does not.
