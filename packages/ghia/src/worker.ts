import type { HotPayload } from "vite"
import { createNodeImportMeta, ESModulesEvaluator, ModuleRunner } from "vite/module-runner"
import type { WorkerInit } from "./protocol.js"
import { createFullReload, createSerialQueue } from "./reload.js"

const init = await new Promise<WorkerInit>((resolve) => {
  addEventListener("message", (event) => resolve(event.data), { once: true })
})

let cleanup: (() => void) | undefined
const enqueue = createSerialQueue()

const reload = createFullReload({
  enqueue,
  runner: () => runner,
  stop() {
    const detach = cleanup
    cleanup = undefined
    detach?.()
  },
  start,
})

const runner = new ModuleRunner(
  {
    transport: {
      connect(handlers) {
        init.vitePort.onmessage = (event) => {
          const payload: HotPayload = event.data
          // The default full reload re-imports the entry module only; `serve` has to run again.
          if (payload.type === "full-reload") reload(payload)
          else handlers.onMessage(payload)
        }
      },
      send(payload) {
        init.vitePort.postMessage(payload)
      },
    },
    createImportMeta: createNodeImportMeta,
  },
  new ESModulesEvaluator()
)

async function start(): Promise<void> {
  const module = await runner.import(init.entry)
  if (typeof module.default !== "function") {
    throw new Error(`${init.entry} must export default function serve(port: MessagePort): () => void`)
  }
  const detach = module.default(init.serverPort)
  if (typeof detach !== "function") {
    throw new Error(`serve() in ${init.entry} must return a function that detaches its handler`)
  }
  cleanup = detach
}

enqueue(start)
