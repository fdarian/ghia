import { defineConfig } from "vite"
import { ghia } from "ghia"

export default defineConfig({
  plugins: [ghia({ entry: "main.ts", server: "server.ts" })],
})
