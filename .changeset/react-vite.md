---
'@ghia/react': minor
---

`@ghia/react/vite` exports `react()`: @vitejs/plugin-react's JSX transform with the automatic runtime and `jsxImportSource: "@ghia/react"`, and React Fast Refresh in `ghia dev`. An edit to a component module updates the tree in place and keeps the `useState` of the components around it, and the entry does not run again; any other edit re-runs the entry, and refresh still works after it. Use it next to `ghia()` in the Vite config, and run React apps with `ghia dev` and `ghia build` instead of `bun --hot`. `react({ include, exclude })` scopes it to some files, for an app that also uses `solid()`. `ghia` and `vite` are optional peer dependencies, as for `@ghia/solid`.
