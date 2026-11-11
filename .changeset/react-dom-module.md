---
"@ghia/react": minor
---

`@ghia/react/react-dom` stands in for `react-dom`: `createPortal`, `flushSync` and `version`, as named exports and as the default export object, and nothing else. `react()` from `@ghia/react/vite` resolves the bare `react-dom` import to it, for the app and for packages in `node_modules`, under `ghia dev`, `ghia build` and vitest, so libraries that import `* as ReactDOM from 'react-dom'` (Base UI) run unchanged. `react-dom/client` and `react-dom/server` stay unresolved.
