import { defineConfig } from "vite"
import { ghia } from "ghia"

export default defineConfig({
  oxc: { jsx: { runtime: "classic", pragma: "h" } },
  build: { sourcemap: true },
  plugins: [ghia({ entry: "main.ts", server: "server.ts" })],
})
