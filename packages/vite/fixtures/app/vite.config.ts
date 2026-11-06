import { defineConfig } from "vite"
import { ghia } from "@ghia/vite"

export default defineConfig({
  plugins: [ghia({ entry: "main.ts" })],
})
