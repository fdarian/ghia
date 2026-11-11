import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The Solid examples' tests. They need the `ghia` plugin and the Solid transform, which would break the React
// examples' tests (the plugin's environment inlines safe-mdx's browser-only dependencies), so they run apart:
// `bun run test:solid`.
export default defineConfig({
  plugins: [ghia(), solid({ include: `${import.meta.dirname}/solid/**` })],
  test: { environment: 'node', include: ['tanstack-virtual.test.tsx'] },
})
