import { defineConfig } from "vitest/config"
import { ghia } from "ghia"

export default defineConfig({
  plugins: [ghia()],
  test: { environment: "node", include: ["*.check.ts"] },
})
