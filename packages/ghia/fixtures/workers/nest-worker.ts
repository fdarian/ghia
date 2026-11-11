const inner = new Worker(new URL("./inner-worker.ts", import.meta.url))
inner.addEventListener("message", (event: MessageEvent<string>) => postMessage(`nested ${event.data}`))
