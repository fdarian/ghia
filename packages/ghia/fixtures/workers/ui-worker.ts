import { greeting } from "./greeting.ts"

postMessage(`${greeting("ui")} window=${typeof window}`)
