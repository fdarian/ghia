import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The perf gate (`bun run test:perf-gate`): Solid files only, so it runs apart from the React examples' tests like the
// Solid examples' suite does.
export default defineConfig({
  plugins: [ghia(), solid({ include: [`${import.meta.dirname}/solid/**`, `${import.meta.dirname}/perf-gate/**`] })],
  test: { environment: 'node', include: ['perf-gate/perf-gate.test.tsx'] },
})
