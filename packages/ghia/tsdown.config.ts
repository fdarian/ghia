import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/**/*.{ts,tsx}", "!src/**/__tests__/**", "!src/**/*.d.ts"],
  format: ["esm"],
  platform: "node",
  unbundle: true,
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  outDir: "dist",
  tsconfig: "tsconfig.json",
})
