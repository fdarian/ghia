import { defineConfig } from "vite"
import { ghia } from "ghia"
import { solid } from "@ghia/solid/vite"

export default defineConfig({
  plugins: [ghia({ entry: "main.tsx" }), solid()],
})
