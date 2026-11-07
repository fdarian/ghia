import { ghia } from "@ghia/vite"
import { defineConfig } from "vitest/config"
import { solid } from "./src/vite.ts"

export default defineConfig({
  plugins: [ghia(), solid()],
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.{ts,tsx}"],
  },
})
