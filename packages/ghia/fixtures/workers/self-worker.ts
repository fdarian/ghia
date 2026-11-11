// The first message makes this Worker start a second one of this same file; the second answers its first message.
let child: Worker | undefined
addEventListener("message", (event: MessageEvent<string>) => {
  if (event.data === "spawn") {
    child = new Worker(new URL("./self-worker.ts", import.meta.url))
    child.addEventListener("message", (reply: MessageEvent<string>) => postMessage(`self parent got ${reply.data}`))
    child.postMessage("answer")
  } else {
    postMessage("self child")
  }
})
