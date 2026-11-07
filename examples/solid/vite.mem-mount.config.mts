import { defineConfig } from "vite"
import { ghia } from "@ghia/vite"
import { solid } from "@ghia/solid/vite"

export default defineConfig({
  plugins: [ghia({ entry: "mem-mount.tsx" }), solid()],
})
