import { createServer, isRunnableDevEnvironment } from "vite"
import { ENVIRONMENT_NAME, type GhiaPluginApi } from "./plugin.js"
import { clearVitestMarker, entryEnvironments, findPluginApi, requireEntry } from "./plugin-api.js"
import type { RunOptions } from "./options.js"
import { createFullReload, createSerialQueue } from "./reload.js"
import { unmountAllRoots } from "@ghia/native/roots"
import { SERVER_PORT_SLOT, type WorkerInit } from "./protocol.js"

export interface DevHandle {
  /** Stops the server Worker and the Vite server. */
  close(): Promise<void>
}

/**
 * Runs the app in this process, in the `ghia` environment, with HMR. Resolves once the entry has
 * been evaluated; a full reload then re-runs the entry by itself, so `render()` runs again and
 * has to be re-runnable on the same window. Needs Bun: the server Worker and the native addon do.
 */
export async function dev(options: RunOptions = {}): Promise<DevHandle> {
  clearVitestMarker()
  const server = await createServer({
    configFile: options.configFile,
    root: options.root,
    appType: "custom",
    environments: entryEnvironments(options.entry),
    server: { middlewareMode: true, ws: false },
  })
  const environment = server.environments[ENVIRONMENT_NAME]
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    await server.close()
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not a runnable dev environment`)
  }
  let worker: Worker | undefined
  let closed: Promise<void> | undefined
  const close = () => {
    closed ??= Promise.all([worker?.terminate(), server.close()]).then(() => {
      Reflect.deleteProperty(globalThis, SERVER_PORT_SLOT)
    })
    return closed
  }
  try {
    const api = findPluginApi(server.config.plugins)
    const entry = requireEntry(api, "dev")
    if (api.server !== undefined) worker = startServerWorker(api, api.server)
    api.uiChannel.onFullReload = createFullReload({
      enqueue: createSerialQueue(),
      runner: () => environment.runner,
      stop: unmountAllRoots,
      start: () => environment.runner.import(entry).then(() => undefined),
    })
    await environment.runner.import(entry)
  } catch (error) {
    await close()
    throw error
  }
  return { close }
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
