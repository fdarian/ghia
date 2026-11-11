const worker = new Worker(new URL("./lazy-worker.ts", import.meta.url))
worker.addEventListener("message", (event: MessageEvent<string>) => console.log(`LAZY_WORKER ${event.data}`))
