import { ENVIRONMENT_NAME, findPluginApi, SERVER_ENVIRONMENT_NAME } from "ghia"
import solidRefresh from "solid-refresh/babel"
import type { Plugin, ResolvedConfig } from "vite"
import vitePluginSolid, { type Options } from "vite-plugin-solid"
import { solidLibrarySource } from "./vite/library-source.js"

export const RUN_START_MODULE = "virtual:ghia/solid-run-start"
const RESOLVED_RUN_START_MODULE = `\0${RUN_START_MODULE}`

export type SolidOptions = {
  /** The files `solid()` compiles; default every `.jsx` and `.tsx` file. An app that also uses `react()` names the Solid files here. */
  include?: Options["include"]
  exclude?: Options["exclude"]
}

/**
 * Compiles JSX and TSX for Solid's universal renderer with `@ghia/solid` as its module, and keeps
 * edited components hot in `ghia dev`. Use it next to `ghia()` from `ghia`. It compiles the
 * UI and vitest's test environment, not Ghia's `server` environment, which has no renderer.
 */
export function solid(options: SolidOptions = {}): Plugin[] {
  let hot = false
  let config: ResolvedConfig

  return [
    solidLibrarySource(),
    {
      name: "ghia:solid-refresh",
      configResolved(resolved) {
        config = resolved
        hot = resolved.command === "serve" && resolved.mode !== "production" && resolved.mode !== "test"
      },
    },
    {
      // A reload evaluates solid-js again, and it warns about a second copy when the flag of the
      // first run is still set. The flag goes at the start of each run, so a real duplicate
      // inside one run still warns.
      name: "ghia:solid-run-start",
      resolveId: {
        order: "pre",
        handler(id) {
          if (hot && id === RUN_START_MODULE) return RESOLVED_RUN_START_MODULE
        },
      },
      load(id) {
        if (id === RESOLVED_RUN_START_MODULE) return "delete globalThis.Solid$$\n"
      },
      transform: {
        order: "pre",
        handler(code, id) {
          if (!hot || this.environment.name !== ENVIRONMENT_NAME) return
          if (id.split("?")[0] !== findPluginApi(config.plugins).entry) return
          // Same line, so the line numbers of the entry's source map stay right.
          return { code: `import "${RUN_START_MODULE}"; ${code}`, map: null }
        },
      },
    },
    {
      ...vitePluginSolid({
        include: options.include,
        exclude: options.exclude,
        solid: { generate: "universal", moduleName: "@ghia/solid" },
        // vite-plugin-solid adds solid-refresh only for a `client` consumer: it takes the `server`
        // consumer of Ghia's environment for SSR, and an edit then reloads the whole app.
        babel: (_source, id) =>
          hot && !id.includes("/node_modules/") ? { plugins: [[solidRefresh, { bundler: "vite" }]] } : {},
      }),
      // vite-plugin-solid otherwise applies to every environment.
      applyToEnvironment: (environment) => environment.name !== SERVER_ENVIRONMENT_NAME,
    },
  ]
}
