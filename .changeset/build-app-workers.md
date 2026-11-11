---
"ghia": minor
---

`ghia build` bundles a Worker the app starts with `new Worker(new URL("./raster.ts", import.meta.url))`, in the UI or the server code: the file is bundled on its own into `dist/raster-<hash>.worker.js`, the URL points at it, and the compiled binary carries it, so an app with its own Workers runs as one executable. A URL that is not a relative string literal is not found. The compiled binary no longer loads a `bunfig.toml` or a `.env` from the directory it is launched in. Every chunk of the build is written flat into `dist/` (no `assets/` directory). `ghia()` returns two plugins, the main one and `ghia:workers`, so code that used its result as a single `Plugin` has to index into it. With `build.sourcemap: true`, each Worker has its own `.map` file; with `'inline'` the map stays inline in the Worker. A Worker may start other Workers, or its own file. Each Worker is a build of its own, so a plugin's build hooks run once more for it.
