---
"@ghia/native": minor
---

A focused `contenteditable` takes the platform's text input: what the keyboard types, a dead key's result, the emoji picker and dictation reach it through the window's input handler, once, as `beforeinput` (`insertText`, or `insertReplacementText` for a range the platform replaces), the change and `input`. A `keydown` no longer turns a printable key into text. Enter, Backspace and Delete are still its default and now keep the platform from typing the key as well, and an editing host always gets its `keydown`, with no listener on its path.
