export const SERVER_PORT_SLOT_KEY = "ghia.serverPort"
export const SERVER_PORT_SLOT = Symbol.for(SERVER_PORT_SLOT_KEY)

/** The first message the CLI posts to the server Worker, with both ports transferred. */
export interface WorkerInit {
  /** Carries the Vite module runner traffic between the Worker and the `server` environment. */
  readonly vitePort: MessagePort
  /** The Worker's end of the channel the UI talks to; it is handed to `serve`. */
  readonly serverPort: MessagePort
  /** Absolute path of the server entry. */
  readonly entry: string
}
