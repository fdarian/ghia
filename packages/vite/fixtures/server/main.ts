import { serverPort } from "virtual:ghia/server"

console.log(`UI_START window=${typeof window}`)

let nextId = 0
let lastVersion: unknown
serverPort.addEventListener("message", (event: MessageEvent<{ id: number; result: unknown }>) => {
  if (event.data.result === "echo") {
    console.log("ECHO echo")
  } else if (event.data.result !== lastVersion) {
    lastVersion = event.data.result
    console.log(`VERSION ${lastVersion}`)
  }
})
serverPort.start()

// A call that was in flight when the server reloaded may never be answered, so ask again.
serverPort.postMessage({ id: nextId++, method: "echo" })
setInterval(() => serverPort.postMessage({ id: nextId++, method: "version" }), 50)
