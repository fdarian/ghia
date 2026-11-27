import { defineConfig } from "vitest/config"

export default defineConfig({
  test: { setupFiles: ["./js/testing-setup.ts"] },
})
