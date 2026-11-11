/// <reference types="ghia/client" />
import { serverPort } from "virtual:ghia/server"

const worker = new Worker(new URL("./ui-worker.ts", import.meta.url), { type: "module" })
worker.addEventListener("message", (event: MessageEvent<string>) => console.log(`UI_WORKER ${event.data}`))
worker.addEventListener("error", (event) => console.log(`UI_WORKER_ERROR ${event.message}`))

serverPort.addEventListener("message", (event: MessageEvent<string>) => console.log(`SERVER_WORKER ${event.data}`))
serverPort.start()
serverPort.postMessage("hello")
