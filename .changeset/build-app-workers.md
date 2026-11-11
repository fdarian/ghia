---
"ghia": minor
---

`ghia build` bundles a Worker the app starts with `new Worker(new URL("./raster.ts", import.meta.url))`, in the UI or the server code: the file is bundled on its own into `dist/raster-<hash>.worker.js`, the URL points at it, and the compiled binary carries it, so an app with its own Workers runs as one executable. A URL that is not a relative string literal is not found. The compiled binary no longer loads a `bunfig.toml` or a `.env` from the directory it is launched in. Every chunk of the build is written flat into `dist/` (no `assets/` directory).
