import { defineConfig } from "vitest/config"
import { ghia } from "ghia"

export default defineConfig({
  plugins: [
    // Like vite-plugin-solid, which adds the `solid` condition: `enforce: "pre"` puts it before `ghia()`.
    {
      name: "fixture:custom-condition",
      enforce: "pre",
      configEnvironment(_name, environment) {
        environment.resolve ??= {}
        environment.resolve.conditions = ["custom", ...(environment.resolve.conditions ?? [])]
      },
    },
    ghia(),
  ],
  test: { environment: "node", include: ["*.check.ts"] },
})
