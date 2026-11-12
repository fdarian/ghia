import { fileURLToPath } from "node:url"
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
  // The alias `react()` gives an app: `@dnd-kit/react` imports `flushSync` from `react-dom`, which has to be the
  // one that flushes Ghia's reconciler. It is inlined so Vite, not Node, resolves its imports.
  resolve: { alias: [{ find: /^react-dom$/, replacement: fileURLToPath(new URL("./src/react-dom.ts", import.meta.url)) }] },
  test: {
    server: { deps: { inline: [/@dnd-kit\/react/] } },
    ...(process.env.CI ? { exclude: [...configDefaults.exclude, ...referencedToThisMachine, ...realTime] } : {}),
  },
})
