---
"@ghia/native": minor
"ghia": minor
---

`window.location`, `window.history`, `localStorage` and `sessionStorage` exist on the native build, so `@solidjs/router` and other History API routers run unchanged. `history` is an in-memory session history with `pushState`, `replaceState`, `back`, `forward`, `go`, `popstate` and `hashchange` (`PopStateEvent` and `HashChangeEvent` are globals); a navigation that would load a document, and `location.reload()`, throw `NotSupportedError`. `localStorage` persists to `~/Library/Application Support/<appId>/Local Storage/localStorage.json`; `ghia({ appId })` names the directory and defaults to the `name` in `package.json`.
