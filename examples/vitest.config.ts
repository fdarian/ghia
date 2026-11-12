import { applyMacCpuThrottleFromEnv } from '@ghia/react'
import { REACT_DOM_ALIAS } from '@ghia/react/vite'
import { defineConfig } from 'vitest/config'

applyMacCpuThrottleFromEnv()

export default defineConfig({
  // What `react()` gives an app: the bare `react-dom` import of a web library resolves to Ghia's. It is inlined,
  // with the packages that import it, so Vite and not Node resolves their imports.
  resolve: { alias: [REACT_DOM_ALIAS] },
  test: {
    // What `ghia()` does for an app under vitest: a library written for a page (Base UI reads `typeof document` when
    // it loads) finds the DOM globals installed whatever order a test file imports it in.
    setupFiles: ['@ghia/native/dom-globals'],
    server: { deps: { inline: [/@base-ui/] } },
  },
})
