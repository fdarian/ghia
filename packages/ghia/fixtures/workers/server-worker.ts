import { greeting } from "./greeting.ts"

addEventListener("message", () => postMessage(`${greeting("server")} window=${typeof window}`))
