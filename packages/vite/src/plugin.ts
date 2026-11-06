import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { createRunnableDevEnvironment, DevEnvironment, type Plugin, type ResolvedConfig } from "vite"
import { SERVER_PORT_SLOT_KEY } from "./protocol.js"
import { WorkerHotChannel } from "./worker-channel.js"

export const ENVIRONMENT_NAME = "ghia"
export const SERVER_ENVIRONMENT_NAME = "server"
export const PLUGIN_NAME = "ghia"

const SERVER_PORT_MODULE = "virtual:ghia/server"
const SERVER_MAIN_MODULE = "virtual:ghia/server-main"
const RESOLVED_PREFIX = "\0"

export interface GhiaOptions {
  /** The app entry, relative to the Vite root. It is the single input of the `ghia` build. */
  entry: string
  /**
   * The server entry, relative to the Vite root. It runs in a Worker, in its own `server`
   * environment, and exports `default function serve(port: MessagePort): () => void`: it wires
   * an RPC handler to the port and returns a function that detaches it. The UI reaches the other
   * end of the port through `serverPort` from `virtual:ghia/server`.
   */
  server?: string
}

export interface GhiaPluginApi {
  /** Absolute, symlink-resolved path of the entry. Set once the config is resolved. */
  readonly entry: string
  /** Absolute, symlink-resolved path of the server entry; undefined without the `server` option. */
  readonly server: string | undefined
  /** The transport of the `server` environment's module runner. Needs the `server` option. */
  readonly serverChannel: WorkerHotChannel
}

const ENTRY_FILE_NAMES: Record<string, string> = {
  [ENVIRONMENT_NAME]: "main.js",
  [SERVER_ENVIRONMENT_NAME]: "server.js",
}

const DOM_GLOBALS_IMPORT = 'import "@ghia/native/dom-globals";'

/**
 * Defines the `ghia` environment: the UI process of a Ghia app, which behaves like a browser
 * page (browser export conditions, `window`) but runs inside Bun next to the native addon.
 */
export function ghia(options: GhiaOptions): Plugin<GhiaPluginApi> {
  let entry: string | undefined
  let serverEntry: string | undefined
  const serverChannel = options.server === undefined ? undefined : new WorkerHotChannel()

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
          ...(serverChannel === undefined
            ? {}
            : {
                [SERVER_ENVIRONMENT_NAME]: {
                  // Vite's server defaults apply: Node/Bun resolution, and dependencies in
                  // node_modules stay external so that Bun loads them natively.
                  consumer: "server" as const,
                  dev: {
                    moduleRunnerTransform: true,
                    createEnvironment: (name: string, config: ResolvedConfig) =>
                      new DevEnvironment(name, config, { hot: true, transport: serverChannel }),
                  },
                  build: {
                    // The `ghia` build runs first and empties the output directory.
                    emptyOutDir: false,
                    rolldownOptions: { input: SERVER_MAIN_MODULE },
                  },
                },
              }),
        },
      }
    },

    // A default the user can override: `config` would win over the user's own values.
    configEnvironment(name, environment) {
      const entryFileName = ENTRY_FILE_NAMES[name]
      if (entryFileName === undefined) return
      const output = environment.build?.rolldownOptions?.output
      if (Array.isArray(output)) return
      return {
        build: {
          target: environment.build?.target ?? "esnext",
          rolldownOptions: {
            output: { entryFileNames: entryFileName, ...output },
          },
        },
      }
    },

    configResolved(config) {
      entry = realpathSync(resolve(config.root, options.entry))
      if (options.server !== undefined) {
        serverEntry = realpathSync(resolve(config.root, options.server))
      }
    },

    applyToEnvironment(environment) {
      return environment.name === ENVIRONMENT_NAME || environment.name === SERVER_ENVIRONMENT_NAME
    },

    resolveId(id) {
      if (id === SERVER_PORT_MODULE && this.environment.name === ENVIRONMENT_NAME) {
        return RESOLVED_PREFIX + id
      }
      if (id === SERVER_MAIN_MODULE && this.environment.name === SERVER_ENVIRONMENT_NAME) {
        return RESOLVED_PREFIX + id
      }
    },

    load(id) {
      if (id === RESOLVED_PREFIX + SERVER_PORT_MODULE) {
        if (serverEntry === undefined) {
          throw new Error(
            `"${SERVER_PORT_MODULE}" was imported, but the ghia() plugin has no "server" option. Set server: "<server entry>" in your Vite config.`
          )
        }
        return this.environment.mode === "dev" ? devServerPortModule() : builtServerPortModule()
      }
      if (id === RESOLVED_PREFIX + SERVER_MAIN_MODULE) {
        if (serverEntry === undefined) throw new Error(`"${SERVER_MAIN_MODULE}" needs the "server" option`)
        return serverMainModule(serverEntry)
      }
    },

    transform: {
      order: "pre",
      handler(code, id) {
        if (this.environment.name !== ENVIRONMENT_NAME) return
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
      get server() {
        return serverEntry
      },
      get serverChannel() {
        if (serverChannel === undefined) throw new Error("The ghia() plugin has no \"server\" option")
        return serverChannel
      },
    },
  }
}

/** `ghia dev` starts the Worker and parks the UI's end of the channel in a slot before the UI entry loads. */
function devServerPortModule(): string {
  return `const port = globalThis[Symbol.for(${JSON.stringify(SERVER_PORT_SLOT_KEY)})]
if (port === undefined) throw new Error("${SERVER_PORT_MODULE} was loaded outside \`ghia dev\`, which starts the server Worker")
export const serverPort = port
`
}

function builtServerPortModule(): string {
  return `const channel = new MessageChannel()
const worker = new Worker(new URL("./server.js", import.meta.url))
worker.postMessage({ serverPort: channel.port2 }, [channel.port2])
export const serverPort = channel.port1
`
}

function serverMainModule(serverEntry: string): string {
  return `import serve from ${JSON.stringify(serverEntry)}
addEventListener("message", (event) => serve(event.data.serverPort), { once: true })
`
}
