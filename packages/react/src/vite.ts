import viteReact from "@vitejs/plugin-react"
import { ENVIRONMENT_NAME, SERVER_ENVIRONMENT_NAME, findPluginApi } from "ghia"
import { createFilter, transformWithOxc, type Plugin, type ResolvedConfig } from "vite"
import { reactRefreshWrapperPlugin } from "vite/internal"

export const REFRESH_SETUP_MODULE = "virtual:ghia/react-refresh"
const RESOLVED_REFRESH_SETUP_MODULE = `\0${REFRESH_SETUP_MODULE}`

// plugin-react serves its Fast Refresh runtime under this id, and its wrapper imports it by it.
const REFRESH_RUNTIME_MODULE = "/@react-refresh"

const JSX_IMPORT_SOURCE = "@ghia/react"

/** What `react()` runs once per run of the entry, before any module that renders: plugin-react's preamble, for `globalThis`. */
const REFRESH_SETUP = `import "@ghia/native/dom-globals"
import { injectIntoGlobalHook } from "${REFRESH_RUNTIME_MODULE}"
injectIntoGlobalHook(globalThis)
globalThis.$RefreshReg$ = () => {}
globalThis.$RefreshSig$ = () => (type) => type
`

const CJS_PACKAGES = ["react", "react-reconciler"]

type Pattern = string | RegExp | Array<string | RegExp>

export type ReactOptions = {
  /** The files `react()` compiles and keeps hot. Default `/\.[tj]sx?$/`. A Solid app next to it excludes the Solid files here. */
  include?: Pattern
  /** Default `/\/node_modules\//`. */
  exclude?: Pattern
}

/**
 * Compiles JSX and TSX with the automatic runtime from `@ghia/react`, and keeps edited components
 * hot in `ghia dev`: an edit to a component module updates the tree in place and keeps the
 * `useState` of the components around it, and the entry does not run again. Use it next to
 * `ghia()` from `ghia`. It compiles the UI and not Ghia's `server` environment, which has no renderer.
 *
 * Fast Refresh comes from @vitejs/plugin-react's runtime and wrapper, set up by `react()` itself
 * because that plugin only does it for the `client` consumer, and Ghia's environment is a `server`
 * one: Vite's own transform leaves the refresh registrations out, so `react()` adds them; the
 * runtime reaches `globalThis` through a first import in the entry, instead of the page preamble
 * that plugin-react adds to index.html.
 */
export function react(options: ReactOptions = {}): Plugin[] {
  const include = options.include ?? /\.[tj]sx?$/
  const exclude = options.exclude ?? /\/node_modules\//
  const filter = createFilter(include, exclude)
  let hot = false
  let config: ResolvedConfig

  return [
    ...viteReact({
      include,
      exclude,
      jsxRuntime: "automatic",
      jsxImportSource: JSX_IMPORT_SOURCE,
    }).map((plugin) => skipServerEnvironment(withoutOptimizeDeps(plugin))),
    {
      name: "ghia:react",
      // `ghia()` inlines every dependency of its environment, and Vite's module runner cannot run
      // CommonJS, which React and its reconciler are. Bun loads them natively; `ghia build` bundles them.
      configEnvironment(name, _environment, context) {
        if (name !== ENVIRONMENT_NAME || context.command !== "serve") return
        return { resolve: { external: CJS_PACKAGES } }
      },
    },
    {
      name: "ghia:react-refresh",
      configResolved(resolved) {
        config = resolved
        hot = resolved.command === "serve" && !resolved.isProduction && resolved.mode !== "test"
      },
      resolveId: {
        order: "pre",
        handler(id) {
          if (hot && id === REFRESH_SETUP_MODULE) return RESOLVED_REFRESH_SETUP_MODULE
        },
      },
      load(id) {
        if (id === RESOLVED_REFRESH_SETUP_MODULE) return REFRESH_SETUP
      },
      transform: {
        order: "pre",
        handler(code, id) {
          if (!hot || this.environment.name !== ENVIRONMENT_NAME) return
          const file = id.split("?")[0]
          if (file === findPluginApi(config.plugins).entry && filter(file)) {
            // Same line, so the line numbers of the entry's source map stay right.
            return { code: `import "${REFRESH_SETUP_MODULE}"; ${code}`, map: null }
          }
        },
      },
    },
    {
      // Vite's transform skips the refresh registrations for a `server` consumer.
      name: "ghia:react-refresh-register",
      enforce: "pre",
      applyToEnvironment: (environment) => environment.name === ENVIRONMENT_NAME,
      async transform(code, id) {
        if (!hot) return
        const file = id.split("?")[0]
        if (!file.endsWith("x") || !filter(file)) return
        const result = await transformWithOxc(
          code,
          file,
          { jsx: { runtime: "automatic", importSource: JSX_IMPORT_SOURCE, development: true, refresh: true } },
          undefined,
          config
        )
        return { code: result.code, map: result.map }
      },
    },
    {
      name: "ghia:react-refresh-wrapper",
      apply: "serve",
      applyToEnvironment: (environment) =>
        hot &&
        environment.name === ENVIRONMENT_NAME &&
        reactRefreshWrapperPlugin({
          cwd: process.cwd(),
          include: /\.[tj]sx?(?:\?.*)?$/,
          exclude: /\/node_modules\//,
          jsxImportSource: JSX_IMPORT_SOURCE,
          reactRefreshHost: "",
        }),
    },
  ]
}

function skipServerEnvironment(plugin: Plugin): Plugin {
  const own = plugin.applyToEnvironment
  return {
    ...plugin,
    applyToEnvironment(environment) {
      if (environment.name === SERVER_ENVIRONMENT_NAME) return false
      return own === undefined ? true : own.call(this, environment)
    },
  }
}

/** plugin-react asks Vite to pre-bundle `react-dom` for the browser page; a Ghia app has none, and Vite warns that it cannot find it. */
function withoutOptimizeDeps(plugin: Plugin): Plugin {
  if (plugin.name !== "vite:react-refresh") return plugin
  const own = plugin.config
  if (typeof own !== "function") throw new Error("@vitejs/plugin-react changed the config hook of vite:react-refresh; react() has to be updated")
  return {
    ...plugin,
    async config(userConfig, env) {
      const result = await own.call(this, userConfig, env)
      return result ? { build: result.build } : result
    },
  }
}
