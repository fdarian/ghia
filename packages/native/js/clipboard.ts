import type { NativeRenderer } from "./host.js"
import "./clipboard-global.js"

/** The `navigator.clipboard` text subset. Images and rich items are not supported. */
export interface Clipboard {
  writeText(text: string): Promise<void>
  /** Resolves `""` when the clipboard holds no text, as in the DOM. */
  readText(): Promise<string>
}

export type ClipboardHost = Pick<NativeRenderer, "writeClipboard" | "readClipboard">

export function createClipboard(
  host: () => ClipboardHost | undefined
): Clipboard {
  const requireHost = () => {
    const current = host()
    if (!current?.writeClipboard || !current.readClipboard) {
      throw new Error("No GPUIX renderer with a clipboard is running")
    }
    return current as Required<ClipboardHost>
  }
  return {
    async writeText(text) {
      requireHost().writeClipboard([{ type: "text/plain", data: String(text) }])
    },
    async readText() {
      const text = requireHost()
        .readClipboard()
        .find((entry) => entry.type === "text/plain")
      // The DOM has no "empty" state: readText() of a text-less clipboard is "".
      return text === undefined ? "" : text.data
    },
  }
}

let activeHost: ClipboardHost | undefined

/** The clipboard of the renderer created last. */
export const clipboard: Clipboard = createClipboard(() => activeHost)

/**
 * Point `clipboard` at `host`, and expose it as `navigator.clipboard` when the
 * runtime has a `navigator` without one, so code written for the web runs
 * unchanged. A runtime with no `navigator` is left without one.
 */
export function bindClipboard(host: ClipboardHost): void {
  activeHost = host
  const scope = globalThis as { navigator?: { clipboard?: Clipboard } }
  const target = scope.navigator
  if (target !== undefined && target.clipboard === undefined) {
    Object.defineProperty(target, "clipboard", {
      value: clipboard,
      configurable: true,
      enumerable: true,
    })
  }
}
