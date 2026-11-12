import { applyMacCpuThrottleFromEnv } from '@ghia/react'
import { react } from '@ghia/react/vite'
import { ghia } from 'ghia'
import { defineConfig } from 'vitest/config'

applyMacCpuThrottleFromEnv()

// The Base UI acceptance suite runs on the plugins an app's Vite config has (`vite.config.mts`): `ghia()` inlines
// every dependency, resolves them with the browser conditions and installs the DOM globals; `react()` aliases the
// `react-dom` that `@floating-ui/react-dom` and Base UI import to `@ghia/react`'s. It cannot share `vitest.config.ts`:
// the plugin's environment inlines safe-mdx's browser-only dependencies, which the other examples' tests would trip on.
export default defineConfig({
  plugins: [ghia(), react()],
  test: { environment: 'node', include: ['base-ui/**/*.test.tsx'] },
})
