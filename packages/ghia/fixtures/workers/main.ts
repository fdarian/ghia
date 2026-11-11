/// <reference types="ghia/client" />
import { serverPort } from "virtual:ghia/server"
import { windowAtLoad } from "./shared.ts"

console.log(`SHARED_MAIN ${windowAtLoad}`)

const worker = new Worker(new URL("./ui-worker.ts", import.meta.url), { type: "module" })
worker.addEventListener("message", (event: MessageEvent<string>) => console.log(`UI_WORKER ${event.data}`))
worker.addEventListener("error", (event) => console.log(`UI_WORKER_ERROR ${event.message}`))

const common = new Worker(new URL("./common-worker.ts", import.meta.url))
common.addEventListener("message", (event: MessageEvent<string>) => console.log(`COMMON_UI ${event.data}`))

void import("./lazy.ts")

serverPort.addEventListener("message", (event: MessageEvent<string>) => console.log(`SERVER_WORKER ${event.data}`))
serverPort.start()
serverPort.postMessage("hello")
