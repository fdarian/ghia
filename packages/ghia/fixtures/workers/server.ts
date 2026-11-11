const worker = new Worker(new URL("./server-worker.ts", import.meta.url))

export default function serve(port: MessagePort): () => void {
  worker.addEventListener("message", (event: MessageEvent<string>) => port.postMessage(event.data))
  port.addEventListener("message", () => worker.postMessage("ping"))
  port.start()
  return () => worker.terminate()
}
