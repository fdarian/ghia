import { defineConfig } from "vite"
import { ghia } from "ghia"

export default defineConfig({
  oxc: { jsx: { runtime: "classic", pragma: "h" } },
  plugins: [ghia({ entry: "main.ts", server: "server.ts" })],
})
