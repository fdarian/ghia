---
'@ghia/native': patch
---

An app with a `<webview>` no longer wakes JS 4 times a second at rest: WebKit's own wake-ups of the main run loop reach JS (2 to 5 wakes in 15 s at rest instead of about 63), and the events of a load, a page-set title and the result of `executeJavaScript` arrive in 1 to 9 ms instead of 5 to 75 ms. On a macOS version whose `CoreFoundation` is not the one this was checked against, the 250 ms timer is used as before.
