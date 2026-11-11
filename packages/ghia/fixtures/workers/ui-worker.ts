import { greeting } from "./greeting.ts"
import { windowAtLoad } from "./shared.ts"

postMessage(`${greeting("ui")} window=${typeof window} shared=${windowAtLoad}`)
