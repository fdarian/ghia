import { applyMacCpuThrottleFromEnv } from '@ghia/react'
import { configDefaults, defineConfig } from 'vitest/config'

applyMacCpuThrottleFromEnv()

// The Base UI suite (`base-ui/`) has its own config, `vitest.base-ui.config.ts`, and the Solid examples theirs.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'base-ui/**'] },
})
