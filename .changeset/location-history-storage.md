---
"@ghia/native": minor
"ghia": minor
---

`window.location`, `window.history`, `localStorage` and `sessionStorage` exist on the native build, so `@solidjs/router` and other History API routers run unchanged. `history` is an in-memory session history with `pushState`, `replaceState`, `back`, `forward`, `go`, `popstate` and `hashchange` (`PopStateEvent` and `HashChangeEvent` are globals); a navigation that would load a document, and `location.reload()`, throw `NotSupportedError`. `localStorage` persists to `~/Library/Application Support/<appId>/Local Storage/localStorage.json`; `ghia({ appId })` names the directory and defaults to the `name` in `package.json`.

`<a>` and `<area>` have the link members of the HTML standard (`href` resolved against `location.href`, `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`, `target`, `download`, `rel`, `relList`, `referrerPolicy` and more), and a click that nothing canceled on an `<a href>` follows a fragment link; any other URL only warns once. A click on `<A>` or `<a>` inside `@solidjs/router`'s `<Router>` navigates.
