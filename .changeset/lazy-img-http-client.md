---
"@ghia/native": patch
---

macOS: the HTTP client for `<img src="https://…">` is built on the first http(s) fetch, on a background thread, not at startup: the window no longer waits ~76 ms for the system trust store to load
