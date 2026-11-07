import type { HotChannel, HotChannelClient, HotChannelListener, HotPayload } from "vite"

/**
 * The Vite side of the server Worker's module runner transport: a `HotChannel` that rides one
 * MessagePort. Vite answers the runner's `fetchModule` requests and sends HMR payloads over it.
 */
export class WorkerHotChannel implements HotChannel {
  /** The channel is never exposed over the network, so the file-serving check has nothing to guard. */
  readonly skipFsCheck = true

  private port: MessagePort | undefined
  private readonly listeners = new Map<string, Set<HotChannelListener>>()
  private readonly client: HotChannelClient = {
    send: (payload) => this.post(payload),
  }

  connect(port: MessagePort): void {
    if (this.port !== undefined) throw new Error("The server Worker is already connected")
    this.port = port
    port.onmessage = (event) => {
      const payload: HotPayload = event.data
      if (payload.type !== "custom") return
      for (const listener of this.listeners.get(payload.event) ?? []) {
        listener(payload.data, this.client)
      }
    }
  }

  send(payload: HotPayload): void {
    // No Worker yet: nothing to notify, as with a dev server that has no browser tab open.
    if (this.port === undefined) return
    this.post(payload)
  }

  on(event: string, listener: HotChannelListener): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }

  off(event: string, listener: Function): void {
    this.listeners.get(event)?.delete(listener as HotChannelListener)
  }

  close(): void {
    this.listeners.clear()
    this.port?.close()
    this.port = undefined
  }

  private post(payload: HotPayload): void {
    if (this.port === undefined) throw new Error("The server Worker is not connected")
    this.port.postMessage(payload)
  }
}
