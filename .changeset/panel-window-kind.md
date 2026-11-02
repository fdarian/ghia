---
'@ghia/native': patch
'@ghia/react': patch
'@ghia/solid': patch
---

`kind: 'panel'` in the window options opens the window as a non-activating panel: a normal window (titlebar, resizing, buttons, appearance, background, normal window level) that can be the key window without activating the app. With `focus: true` it is key while the frontmost app stays frontmost, so a capture can show the key look (glass tints, accent colours, traffic lights) that a `focus: false` window never has. `renderer.isWindowKey()` reads whether AppKit reports the window as key. An unknown `kind` throws; `'normal'` is the default, and on Windows and Linux a panel is a normal window. A panel takes the keyboard like any key window, so open one only for a capture and close it right after.
