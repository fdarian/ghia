---
'@ghia/native': patch
---

An app that does not turn automation on no longer loads zod (about 1.8 MB of heap). `@ghia/native/runtime` imported the automation client, and with it zod and eventsource-parser, at the top; it now imports it when automation is enabled (stdin is not a TTY, or a browser render). `enableAutomation` and `installBrowserAutomation` return a promise for that reason, and in the browser `globalThis.gpuix` is set once the client has loaded instead of inside `render()`.
