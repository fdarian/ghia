/** A window that can be asked for a frame: a renderer with a native window behind it. */
export interface FrameSource {
  /** True when the window will run the callbacks in its next frame, false while it has no window yet. */
  requestAnimationFrame?(): boolean
}

export type FrameCallback = (time: number) => void

/**
 * The `requestAnimationFrame` callbacks of one window. The frame steps of the window that
 * `source` stands for run them; a callback requested while no window is attached waits for one.
 */
export class FrameList {
  private callbacks = new Map<number, FrameCallback>()
  /** The callbacks of the frame that is running, so that a cancel reaches the ones not yet called. */
  private running: Map<number, FrameCallback> | undefined
  private source: FrameSource | undefined
  /** The source was asked for a frame and has not run it yet. */
  private asked = false

  /**
   * Handles are shared by every list, so a handle names one callback of the app: one list never
   * hands out the number another's callback has.
   */
  private static nextHandle = 0

  request(callback: FrameCallback): number {
    if (typeof callback !== "function") {
      throw new TypeError("requestAnimationFrame: the callback is not a function")
    }
    const handle = ++FrameList.nextHandle
    this.callbacks.set(handle, callback)
    this.ask()
    return handle
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle)
    this.running?.delete(handle)
  }

  /**
   * Lets this list ask `source`'s window for frames. Callbacks that wait for a window are asked of
   * it now. The returned function detaches it again.
   */
  attach(source: FrameSource): () => void {
    this.source = source
    this.asked = false
    this.ask()
    return () => {
      if (this.source !== source) return
      this.source = undefined
      this.asked = false
    }
  }

  /** Asks the window again for the frame callbacks wait for, which a window that was not open yet could not have. */
  resume(): void {
    this.ask()
  }

  /**
   * The frame steps of the window ran at `time`, the clock they ran at: calls the callbacks with it,
   * in the order they were requested, and gives an error one throws to `report`. The callbacks of a
   * frame are the ones requested before it; what they request waits for the next.
   */
  run(time: number, report: (error: unknown) => void): void {
    this.asked = false
    if (this.callbacks.size === 0) return
    const batch = this.callbacks
    this.callbacks = new Map()
    this.running = batch
    try {
      for (const [handle, callback] of [...batch]) {
        if (!batch.has(handle)) continue
        batch.delete(handle)
        try {
          callback(time)
        } catch (error) {
          report(error)
        }
      }
    } finally {
      this.running = undefined
    }
  }

  private ask(): void {
    const source = this.source
    if (this.asked || this.callbacks.size === 0 || source === undefined || source.requestAnimationFrame === undefined) return
    try {
      if (source.requestAnimationFrame()) this.asked = true
    } catch {
      // `requestAnimationFrame` must not throw, as the DOM's does not. The callback stays queued and
      // runs in the next frame steps of the window, or when it is attached or opened.
    }
  }
}
