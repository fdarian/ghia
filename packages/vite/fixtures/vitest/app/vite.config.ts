import { defineConfig } from "vitest/config"
import { ghia } from "@ghia/vite"

export default defineConfig({
  plugins: [ghia()],
  test: { environment: "node", include: ["*.check.ts"] },
})
