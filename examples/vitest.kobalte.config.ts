import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The Kobalte acceptance suite runs on the plugins an app's Vite config has: `ghia()` bundles every dependency with
// the browser conditions and installs the DOM globals; `solid()` compiles Kobalte's `.jsx` source (its `solid` export
// condition) like the app's own files. Its own config, because the `ghia()` environment inlines safe-mdx's
// browser-only dependencies, which the other examples' tests trip on.
export default defineConfig({
  plugins: [ghia(), solid()],
  test: { environment: 'node', include: ['kobalte/**/*.test.tsx'] },
})
