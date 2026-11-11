import { defineConfig } from "vite"
import { ghia } from "ghia"
import { react } from "@ghia/react/vite"

export default defineConfig({
  plugins: [ghia({ entry: "main.tsx" }), react()],
  test: { include: ["*.vitest.tsx"] },
})
