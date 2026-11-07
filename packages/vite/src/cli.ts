#!/usr/bin/env bun
import { parseArgs } from "node:util"
import {
  createBuilder,
  createServer,
  isRunnableDevEnvironment,
  type Plugin,
  type ViteDevServer,
} from "vite"
import { ENVIRONMENT_NAME, PLUGIN_NAME, SERVER_ENVIRONMENT_NAME, type GhiaPluginApi } from "./plugin.js"
import { SERVER_PORT_SLOT, type WorkerInit } from "./protocol.js"

const USAGE = `Usage: ghia <dev|build> [--config <file>]`

function findPluginApi(plugins: readonly Plugin[]): GhiaPluginApi {
  const plugin = plugins.find((candidate) => candidate.name === PLUGIN_NAME)
  if (plugin === undefined) {
    throw new Error(`Add ghia() from "@ghia/vite" to the plugins of your Vite config`)
  }
  return plugin.api as GhiaPluginApi
}

function requireEntry(api: GhiaPluginApi, command: string): string {
  if (api.entry === undefined) {
    throw new Error(`ghia ${command} needs an entry: set ghia({ entry: "<entry file>" }) in your Vite config`)
  }
  return api.entry
}

async function dev(configFile: string | undefined): Promise<void> {
  const server = await createServer({
    configFile,
    appType: "custom",
    server: { middlewareMode: true, ws: false },
  })
  const environment = server.environments[ENVIRONMENT_NAME]
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    await server.close()
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not a runnable dev environment`)
  }
  const api = findPluginApi(server.config.plugins)
  let entry: string
  try {
    entry = requireEntry(api, "dev")
  } catch (error) {
    await server.close()
    throw error
  }
  const worker = api.server === undefined ? undefined : startServerWorker(api, api.server)
  stopOnSignal(server, worker)

  // A full reload makes the runner clear its module cache and re-import the entry by itself,
  // so `render()` runs again; it is built to be re-run on the same window.
  try {
    await environment.runner.import(entry)
  } catch (error) {
    await worker?.terminate()
    await server.close()
    throw error
  }
}

/**
 * Starts the Worker that runs the `server` environment and hands the UI its end of the port
 * through a global slot, which `virtual:ghia/server` reads when the UI entry loads.
 */
function startServerWorker(api: GhiaPluginApi, serverEntry: string): Worker {
  const worker = new Worker(new URL("./worker.js", import.meta.url))
  const vite = new MessageChannel()
  const server = new MessageChannel()
  api.serverChannel.connect(vite.port1)
  const init: WorkerInit = { vitePort: vite.port2, serverPort: server.port2, entry: serverEntry }
  worker.postMessage(init, [vite.port2, server.port2])
  Object.defineProperty(globalThis, SERVER_PORT_SLOT, { value: server.port1, configurable: true })
  return worker
}

function stopOnSignal(server: ViteDevServer, worker: Worker | undefined): void {
  const stop = () => {
    Promise.all([worker?.terminate(), server.close()]).finally(() => process.exit(0))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

async function build(configFile: string | undefined): Promise<void> {
  const builder = await createBuilder({ configFile })
  requireEntry(findPluginApi(builder.config.plugins), "build")
  const environment = builder.environments[ENVIRONMENT_NAME]
  if (environment === undefined) {
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not defined; add ghia() to your Vite config`)
  }
  await builder.build(environment)
  const serverEnvironment = builder.environments[SERVER_ENVIRONMENT_NAME]
  // After the `ghia` build, which empties the output directory.
  if (serverEnvironment !== undefined) await builder.build(serverEnvironment)
}

async function main(): Promise<void> {
  // A test that spawns `ghia` hands down vitest's marker, and ghia() would then configure for tests.
  delete process.env.VITEST
  if (!process.versions.bun) {
    throw new Error("ghia runs the app inside its own process with the native addon, so it needs Bun")
  }
  const args = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string", short: "c" } },
  })
  const command = args.positionals[0]
  if (command === "dev") await dev(args.values.config)
  else if (command === "build") await build(args.values.config)
  else throw new Error(USAGE)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
