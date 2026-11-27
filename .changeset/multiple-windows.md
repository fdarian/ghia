---
"@ghia/native": minor
"@ghia/solid": minor
"@ghia/react": minor
---

An app has several windows. Each `GpuixRenderer` that calls `init()` opens a window on the one app (macOS), and one shared frame loop serves them all: a window closed alone leaves the others running, and the app ends with its last window or on a quit, running `onTerminated` once. Every window has its own `document` and `window` (`documentOf(renderer)`, `windowOf(renderer)`), with its own `<html>`, `<head>` and `<body>`, `activeElement`, selection, `matchMedia`, size and `resize`, and an event is heard by the window it happened in; the global `document` and `window` are the first window's. The test renderer opens several test windows at once.

`window.open('', name, 'width=..,height=..,left=..,top=..')` opens a new native window and returns a `Window` object (`document`, `opener`, `name`, `closed`, `close()`, `focus()`, `resizeTo()`, `innerWidth`, `devicePixelRatio`, `beforeunload`/`pagehide`/`unload`), reusing an open window of the same name; a link to another origin goes to the system, and any other URL throws `NotSupportedError`.

Solid and React render into the new window the web way. Solid: `render(() => <App />, win.document.body)`, which returns the dispose, like `solid-js/web`. React: `createRoot(win.document.body).render(<App />)`, like `react-dom/client`. `<Portal mount={win.document.body}>` and `createPortal(children, win.document.body)` reach another window too. Both adapters register the factory `window.open` needs for every root they own, closing a window unmounts what was rendered in it (cleanups run), and `render()` keeps a slot for each renderer instead of one global.
