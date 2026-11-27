import { ghia } from "ghia"
import { defineConfig } from "vitest/config"
import { solid } from "./src/vite.ts"

export default defineConfig({
  plugins: [ghia(), solid()],
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
})
