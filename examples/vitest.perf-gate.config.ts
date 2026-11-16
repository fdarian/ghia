import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'
import { defineConfig } from 'vitest/config'

// The perf gate (`bun run test:perf-gate`): Solid files only, so it runs apart from the React examples' tests like the
// Solid examples' suite does.
export default defineConfig({
  plugins: [ghia(), solid({ include: [`${import.meta.dirname}/solid/**`, `${import.meta.dirname}/perf-gate/**`] })],
  // A scenario builds three windows (a warm-up and two measured); on a shared CI runner that took 4 to 5.5 s, past vitest's 5 s default.
  test: {
    environment: 'node',
    include: ['perf-gate/*.test.tsx'],
    testTimeout: 60_000,
    // cold-mount.test.tsx measures the first window of a process, so each file needs a process of its own; one after the other,
    // so the timings of a loaded runner do not depend on the other file.
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    globalSetup: ['perf-gate/global-setup.ts'],
  },
})
