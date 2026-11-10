/** A window that can be asked for a frame: a renderer with a native window behind it. */
export interface FrameSource {
  /** True when the window will run the callbacks in its next frame, false while it has no window yet. */
  requestAnimationFrame?(): boolean
}

type FrameCallback = (time: number) => void

interface Frames {
  callbacks: Map<number, FrameCallback>
  /** The callbacks of the frame that is running, so that a cancel reaches the ones not yet called. */
  running: Map<number, FrameCallback> | undefined
  nextHandle: number
  sources: Set<FrameSource>
  /** Sources a frame was asked of and has not run yet. */
  asked: Set<FrameSource>
}

/** Kept on `globalThis`: under `bun --hot` this module is evaluated again while callbacks wait. */
const FRAMES_KEY = Symbol.for("@ghia/native/animation-frames")

function frames(): Frames {
  const existing = Reflect.get(globalThis, FRAMES_KEY) as Frames | undefined
  if (existing) return existing
  const created: Frames = {
    callbacks: new Map(),
    running: undefined,
    nextHandle: 0,
    sources: new Set(),
    asked: new Set(),
  }
  Reflect.set(globalThis, FRAMES_KEY, created)
  return created
}

function ask(source: FrameSource): void {
  const state = frames()
  if (state.asked.has(source) || !source.requestAnimationFrame) return
  try {
    if (source.requestAnimationFrame()) state.asked.add(source)
  } catch {
    // `requestAnimationFrame` must not throw, as the DOM's does not. The callback stays queued and
    // runs in the next frame steps of any window, or when a window is attached or opened.
  }
}

/**
 * Lets `requestAnimationFrame` ask this window for frames. Callbacks that wait for a window are
 * asked of it now. The returned function takes it out.
 */
export function addFrameSource(source: FrameSource): () => void {
  const state = frames()
  state.sources.add(source)
  if (state.callbacks.size > 0) ask(source)
  return () => {
    state.sources.delete(source)
    state.asked.delete(source)
  }
}

/** Asks `source` again for the frame callbacks wait for, which a window that was not open yet could not have. */
export function resumeFrameRequests(source: FrameSource): void {
  if (frames().callbacks.size > 0) ask(source)
}

export function requestAnimationFrame(callback: FrameCallback): number {
  if (typeof callback !== "function") {
    throw new TypeError("requestAnimationFrame: the callback is not a function")
  }
  const state = frames()
  const handle = ++state.nextHandle
  state.callbacks.set(handle, callback)
  for (const source of state.sources) ask(source)
  return handle
}

export function cancelAnimationFrame(handle: number): void {
  const state = frames()
  state.callbacks.delete(handle)
  state.running?.delete(handle)
}

/**
 * The frame steps of `source`'s window ran at `time`, the clock they ran at: calls the callbacks with
 * it, in the order they were requested, and gives an error one throws to `report`. The callbacks of
 * a frame are the ones requested before it; what they request waits for the next. With several
 * windows the first whose steps run takes them all.
 */
export function runAnimationFrame(
  source: FrameSource,
  time: number,
  report: (error: unknown) => void
): void {
  const state = frames()
  state.asked.delete(source)
  if (state.callbacks.size === 0) return
  const batch = state.callbacks
  state.callbacks = new Map()
  state.running = batch
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
    state.running = undefined
  }
}
