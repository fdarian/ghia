import { createServerHotChannel, type HotChannel } from "vite"
import type { FullReloadPayload } from "./reload.js"

export interface UiHotChannel extends HotChannel {
  /** Receives the `full-reload` payloads instead of the runner. Without it the runner's own handling applies. */
  onFullReload: ((payload: FullReloadPayload) => void) | undefined
}

/** The `ghia` environment's channel to its in-process module runner: Vite's own, except that `full-reload` goes to `onFullReload`. */
export function createUiHotChannel(): UiHotChannel {
  const inner = createServerHotChannel()
  const channel: UiHotChannel = {
    ...inner,
    onFullReload: undefined,
    send(payload) {
      if (payload.type === "full-reload" && channel.onFullReload !== undefined) {
        channel.onFullReload(payload)
      } else {
        inner.send?.(payload)
      }
    },
  }
  return channel
}
