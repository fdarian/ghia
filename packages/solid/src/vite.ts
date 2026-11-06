import solidRefresh from "solid-refresh/babel"
import type { Plugin } from "vite"
import vitePluginSolid from "vite-plugin-solid"

/**
 * Compiles JSX and TSX for Solid's universal renderer with `@ghia/solid` as its module, and keeps
 * edited components hot in `ghia dev`. Use it next to `ghia()` from `@ghia/vite`.
 */
export function solid(): Plugin[] {
  let hot = false

  return [
    {
      name: "ghia:solid-refresh",
      configResolved(config) {
        hot = config.command === "serve" && config.mode !== "production" && config.mode !== "test"
      },
    },
    vitePluginSolid({
      solid: { generate: "universal", moduleName: "@ghia/solid" },
      // vite-plugin-solid adds solid-refresh only for a `client` consumer: it takes the `server`
      // consumer of Ghia's environment for SSR, and an edit then reloads the whole app.
      babel: (_source, id) =>
        hot && !id.includes("/node_modules/") ? { plugins: [[solidRefresh, { bundler: "vite" }]] } : {},
    }),
  ]
}
