import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { createRunnableDevEnvironment, type Plugin } from "vite"

export const ENVIRONMENT_NAME = "ghia"
export const PLUGIN_NAME = "ghia"

export interface GhiaOptions {
  /** The app entry, relative to the Vite root. It is the single input of the `ghia` build. */
  entry: string
}

export interface GhiaPluginApi {
  /** Absolute, symlink-resolved path of the entry. Set once the config is resolved. */
  readonly entry: string
}

const DOM_GLOBALS_IMPORT = 'import "@ghia/native/dom-globals";'

/**
 * Defines the `ghia` environment: the UI process of a Ghia app, which behaves like a browser
 * page (browser export conditions, `window`) but runs inside Bun next to the native addon.
 */
export function ghia(options: GhiaOptions): Plugin<GhiaPluginApi> {
  let entry: string | undefined

  return {
    name: PLUGIN_NAME,

    config() {
      return {
        environments: {
          [ENVIRONMENT_NAME]: {
            // `client` would get Vite's browser HMR client and no dependency externalization.
            consumer: "server",
            dev: {
              moduleRunnerTransform: true,
              createEnvironment: (name, config) =>
                createRunnableDevEnvironment(name, config, { hot: true }),
            },
            resolve: {
              conditions: ["browser", "import", "module", "default"],
              noExternal: true,
              // The addon has to load natively. External is a prefix match, so the subpaths
              // follow, and the `browser` export (a wasm build) is never picked.
              external: ["@ghia/native"],
            },
            build: {
              rolldownOptions: { input: options.entry },
            },
          },
        },
      }
    },

    // A default the user can override: `config` would win over the user's own values.
    configEnvironment(name, environment) {
      if (name !== ENVIRONMENT_NAME) return
      const output = environment.build?.rolldownOptions?.output
      if (Array.isArray(output)) return
      return {
        build: {
          target: environment.build?.target ?? "esnext",
          rolldownOptions: {
            output: { entryFileNames: "main.js", ...output },
          },
        },
      }
    },

    configResolved(config) {
      entry = realpathSync(resolve(config.root, options.entry))
    },

    applyToEnvironment(environment) {
      return environment.name === ENVIRONMENT_NAME
    },

    transform: {
      order: "pre",
      handler(code, id) {
        if (id.split("?")[0] !== entry) return
        // Same line, so the line numbers of the entry's source map stay right.
        return { code: `${DOM_GLOBALS_IMPORT} ${code}`, map: null }
      },
    },

    api: {
      get entry() {
        if (entry === undefined) throw new Error("The ghia() plugin has not resolved its config yet")
        return entry
      },
    },
  }
}
