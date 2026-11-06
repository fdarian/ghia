// Compiler setup follows @opentui/solid (MIT, anomalyco/opentui).
import { plugin as registerBunPlugin, type BunPlugin } from "bun"
import { readFile } from "node:fs/promises"
import { babelTransform, cachedTransform, defaultCacheDir, transformIdentity } from "./transform-cache.js"

const PLUGIN_STATE = Symbol.for("@ghia/solid/bun-plugin")

function stripQuery(path: string): string {
  return path.split(/[?#]/, 1)[0]!
}

// Bun resolves each solid-js entry through the `node` export condition to its server build, whose
// `isServer` is true. Each is loaded from the client build beside it instead.
const clientBuilds = [
  { server: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/, client: "solid.js" },
  { server: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/, client: "store.js" },
  { server: /[/\\]node_modules[/\\]solid-js[/\\]web[/\\]dist[/\\]server\.js(?:[?#].*)?$/, client: "web.js" },
]

export function createSolidPlugin(): BunPlugin {
  return {
    name: "gpuix-solid",
    setup(build) {
      for (const entry of clientBuilds) {
        build.onLoad({ filter: entry.server }, async ({ path }) => ({
          contents: await readFile(stripQuery(path).replace("server.js", entry.client), "utf8"),
          loader: "js",
        }))
      }
      build.onLoad(
        { filter: /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/ },
        async ({ path }) => {
          const filename = stripQuery(path)
          return {
            contents: await cachedTransform({
              dir: defaultCacheDir,
              filename,
              source: await readFile(filename, "utf8"),
              identity: await transformIdentity(filename),
              transform: babelTransform,
            }),
            loader: "js",
          }
        }
      )
    },
  }
}

export function ensureSolidPlugin(): boolean {
  const state = globalThis as typeof globalThis & { [PLUGIN_STATE]?: boolean }
  if (state[PLUGIN_STATE]) return false
  void registerBunPlugin(createSolidPlugin())
  state[PLUGIN_STATE] = true
  return true
}

const solidPlugin = createSolidPlugin()
export default solidPlugin
