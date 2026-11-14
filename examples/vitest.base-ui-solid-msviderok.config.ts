import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The base-ui-solid suite (`base-ui-solid/*.test.tsx` imports `@photon-ai/base-ui-solid`) against the other Solid
// port of Base UI, `@msviderok/base-ui-solid`.
export default defineConfig({
  plugins: [ghia(), solid()],
  resolve: {
    alias: [{ find: /^@photon-ai\/base-ui-solid(\/|$)/, replacement: '@msviderok/base-ui-solid$1' }],
  },
  test: { environment: 'node', include: ['base-ui-solid/**/*.test.tsx'] },
})
