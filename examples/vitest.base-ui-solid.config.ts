import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The Solid ports of Base UI run unmodified from their git source (their `exports` point at `src/*.ts`), compiled by
// the plugins an app's Vite config has, as the Kobalte suite does. Their npm tarballs ship DOM-compiled code only,
// which `solid()` refuses. The same files run against `@msviderok/base-ui-solid` through the second config, whose
// alias is the only difference.
export default defineConfig({
  plugins: [ghia(), solid()],
  test: { environment: 'node', include: ['base-ui-solid/**/*.test.tsx'] },
})
