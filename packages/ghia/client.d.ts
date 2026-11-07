declare module "virtual:ghia/server" {
  /** The UI's end of the channel to the server Worker started from the `server` option of `ghia()`. */
  export const serverPort: MessagePort
}
