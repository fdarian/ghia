import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The perf gate (`bun run test:perf-gate`): Solid files only, so it runs apart from the React examples' tests like the
// Solid examples' suite does.
export default defineConfig({
  plugins: [ghia(), solid({ include: [`${import.meta.dirname}/solid/**`, `${import.meta.dirname}/perf-gate/**`] })],
  // A scenario builds three windows (a warm-up and two measured); on a shared CI runner that took 4 to 5.5 s, past vitest's 5 s default.
  test: { environment: 'node', include: ['perf-gate/perf-gate.test.tsx'], testTimeout: 60_000 },
})
