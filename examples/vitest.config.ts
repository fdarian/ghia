import { applyMacCpuThrottleFromEnv } from '@ghia/react'
import { configDefaults, defineConfig } from 'vitest/config'

applyMacCpuThrottleFromEnv()

// The Base UI suite (`base-ui/`) has its own config, `vitest.base-ui.config.ts`, the Kobalte suite (`kobalte/`) `vitest.kobalte.config.ts`, the Solid Base UI ports (`base-ui-solid/`) `vitest.base-ui-solid.config.ts` and `vitest.base-ui-solid-msviderok.config.ts`, and the Solid examples theirs.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'base-ui/**', 'kobalte/**', 'base-ui-solid/**'] },
})
