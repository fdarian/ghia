---
"ghia": minor
---

`ghia build` bundles a Worker the app starts with `new Worker(new URL("./raster.ts", import.meta.url))`, in the UI or the server code: the file becomes `dist/raster-<hash>.worker.js`, the URL points at it, and the compiled binary carries it, so an app with its own Workers runs as one executable. A URL that is not a relative string literal is not found. The compiled binary no longer loads a `bunfig.toml` from the directory it is launched in.
