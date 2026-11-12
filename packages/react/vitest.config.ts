import { configDefaults, defineConfig } from "vitest/config"
import { REACT_DOM_ALIAS } from "./src/vite.ts"

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
  // The alias `react()` gives an app. It is inlined so Vite, not Node, resolves the imports of `@dnd-kit/react`.
  resolve: { alias: [REACT_DOM_ALIAS] },
  test: {
    server: { deps: { inline: [/@dnd-kit\/react/] } },
    ...(process.env.CI ? { exclude: [...configDefaults.exclude, ...referencedToThisMachine, ...realTime] } : {}),
  },
})
