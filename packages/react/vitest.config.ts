import { configDefaults, defineConfig } from "vitest/config"

// Their references were captured on the author's machine (its fonts, its wall-clock times); a shared CI runner's pixels differ.
const referencedToThisMachine = [
  "src/__tests__/font-smoothing.test.tsx",
  "src/__tests__/transform-text.test.tsx",
  "src/__tests__/motion-waapi.test.tsx",
]

// They wait on real time, and a loaded CI VM overshoots their limits.
const realTime = [
  "src/__tests__/filter-motion.test.tsx",
  "src/__tests__/events.test.tsx",
  "src/__tests__/animation-frame-work.test.tsx",
  "src/__tests__/retained-frame-sources.test.tsx",
]

export default defineConfig({
  test: process.env.CI
    ? {
        projects: [
          {
            test: {
              name: "steady",
              exclude: [...configDefaults.exclude, ...referencedToThisMachine, ...realTime],
            },
          },
          {
            test: {
              name: "real-time",
              include: realTime,
              retry: 2,
              testTimeout: 15_000,
            },
          },
        ],
      }
    : {},
})
