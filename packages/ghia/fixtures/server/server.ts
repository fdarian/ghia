import { createRoot } from "solid-js"
import { version } from "./version.ts"

interface Request {
  readonly id: number
  readonly method: "echo" | "version"
}

export default function serve(port: MessagePort): () => void {
  console.log(`SERVER_START window=${typeof window} dep=${typeof createRoot}`)
  const handle = (event: MessageEvent<Request>) => {
    const request = event.data
    port.postMessage({ id: request.id, result: request.method === "echo" ? "echo" : version })
  }
  port.addEventListener("message", handle)
  port.start()
  return () => {
    port.removeEventListener("message", handle)
    console.log("SERVER_CLEANUP")
  }
}
