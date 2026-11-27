import * as native from "@ghia/native"
import { GpuixRenderer } from "@ghia/native"
import type { EventPayload, WindowOptions } from "@ghia/native"
import type { App, LiveAutomationRenderer } from "./automation/client.js"
import { automationRequested } from "./automation/env.js"
import { bindClipboard } from "./clipboard.js"
import { bindEyeDropper } from "./eyedropper.js"
import { bindLinkOpener } from "./shell/open-link.js"
import { flushStorage } from "./shell/storage.js"
import { windowOf } from "./events/window-target.js"
import { windowGone } from "./window-lifecycle.js"
import { bindWindowOpener } from "./window-open.js"
import { detachRenderer } from "./detached-renderer.js"
import { closeWebAnimations } from "./web-animations.js"
import { flushPendingMutations } from "./bounds.js"
import {
  registerKeyframesHost,
  registerKeyframesValidator,
  unregisterKeyframesHost,
} from "./keyframes.js"
import { readFontFiles, type WindowFontsOption } from "./fonts.js"
import { registerAnimationMeasurer } from "./motion-value.js"
import { createRendererState, reportSyncErrors } from "./renderer-state.js"

export type { WindowFontsOption }

const DEFAULT_FRAME_MS = 8

// The browser entry has no `validateKeyframes`, so it is read off the namespace.
if (typeof native.validateKeyframes === "function") {
  registerKeyframesValidator(native.validateKeyframes)
}

if (typeof native.measureMotionAnimation === "function") {
  registerAnimationMeasurer((from, target, transition) => {
    const length = native.measureMotionAnimation(from, target, transition ?? null)
    return { duration: length.duration, iterationDuration: length.iterationDuration }
  })
}

export interface FrameLoop {
  stop(): void
}

export interface CreateNativeRendererOptions {
  onEvent?: (event: EventPayload) => void
  onError?: (error: unknown) => void
}

export function createNativeRenderer(
  options: CreateNativeRendererOptions = {}
): GpuixRenderer {
  let renderer!: GpuixRenderer
  renderer = new GpuixRenderer((error, event) => {
    if (error) {
      options.onError?.(error)
      return
    }
    try {
      if (createRendererState(renderer).dispatch(event)) options.onEvent?.(event)
    } catch (dispatchError) {
      options.onError?.(dispatchError)
    }
  })
  bindClipboard(renderer)
  bindEyeDropper(renderer)
  bindLinkOpener(renderer)
  const state = createRendererState(renderer)
  state.setErrorHandler(options.onError)
  // Input reaches JS here, inside the native call, so preventDefault() can
  // still stop the editor or the focus change.
  renderer.setSyncEventHandler(
    reportSyncErrors((event) => state.dispatchSync(event), (error) => state.reportError(error))
  )
  // A read must see mutations a framework has queued but not sent yet (Solid
  // sends in a microtask), and native draws pending changes before answering.
  const getElementBounds = renderer.getElementBounds.bind(renderer)
  renderer.getElementBounds = (id) => {
    flushPendingMutations(renderer)
    return getElementBounds(id)
  }
  const getElementsAt = renderer.getElementsAt.bind(renderer)
  renderer.getElementsAt = (x, y) => {
    flushPendingMutations(renderer)
    return getElementsAt(x, y)
  }
  const automated =
    typeof process !== "undefined" && automationRequested(process.env)
  const init = renderer.init.bind(renderer)
  const tick = renderer.tick.bind(renderer)
  let title = undefined as string | undefined
  let fontOption = undefined as WindowFontsOption["fonts"]
  let focusOption = undefined as boolean | undefined
  const setWindowTitle = renderer.setWindowTitle.bind(renderer)
  renderer.setWindowTitle = (next) => {
    title = next
    setWindowTitle(next)
  }
  // `window.open` makes another window like this one's on the same app and frame loop.
  bindWindowOpener(renderer, {
    title: () => title,
    create(opened) {
      const sibling = createNativeRenderer(options)
      // The window opens focused unless its opener asked not to take the keyboard (an app driven in the background).
      sibling.init({ ...opened, fonts: fontOption, focus: focusOption } as WindowOptions & WindowFontsOption)
      const loop = frameLoopOptions.get(renderer)
      // Without a loop of the opener's own the app ticks itself, and a second pump would race it.
      if (loop !== undefined) startFrameLoop(sibling, { frameMs: loop.frameMs, onTerminated: loop.onTerminated, onError: loop.onError })
      return sibling
    },
  })
  renderer.init = (windowOptions?: WindowOptions & WindowFontsOption | null) => {
    const fonts = readFontFiles(windowOptions?.fonts)
    title = windowOptions?.title
    fontOption = windowOptions?.fonts
    focusOption = windowOptions?.focus
    init(windowOptions)
    // Callbacks requested before the window existed had no window to ask.
    windowOf(renderer).animationFrames.resume()
    for (const font of fonts) renderer.registerFont(font)
    // The web renderer has no motion engine, so nothing to define keyframes on.
    if (typeof renderer.defineKeyframes === "function") registerKeyframesHost(renderer)
    if (automated) {
      enableAutomation(renderer).catch((error) => state.reportError(error))
    }
  }
  // What a renderer drops once its window is gone: this tick ends the app, or the shared frame loop
  // saw this renderer's window close while the others went on.
  rendererReleasers.set(renderer, () => {
    unregisterKeyframesHost(renderer)
    closeWebAnimations(renderer)
    windowGone(renderer)
    detachRenderer(renderer)
  })
  tickPreparers.set(renderer, () => flushPendingMutations(renderer))
  renderer.tick = () => {
    // Writes an element made since the last flush (`element.style`) reach native before the frame this tick draws.
    flushPendingMutations(renderer)
    const running = tick()
    if (!running) releaseRenderer(renderer)
    return running
  }
  return renderer
}

const rendererReleasers = new WeakMap<object, () => void>()
/** The options a renderer joined the frame loop with, which a window it opens joins with too. */
const frameLoopOptions = new WeakMap<object, FrameLoopOptions>()
const tickPreparers = new WeakMap<object, () => void>()

function releaseRenderer(renderer: object): void {
  rendererReleasers.get(renderer)?.()
}

export interface FrameLoopOptions {
  /** Polls with a timer of this period instead of waking on the run loop. The first renderer of
   *  the shared loop decides: the loop is one. */
  frameMs?: number
  /** The app ended: the last window closed or the platform quit. Runs once, whichever renderer's
   *  options it came from, however many renderers the loop served. */
  onTerminated?: () => void
  /** This renderer's window closed while the app goes on for other windows. */
  onWindowClosed?: () => void
  onError?: (error: unknown) => void
}

type FrameLoopRenderer = Pick<GpuixRenderer, "requiresTick" | "tick"> &
  Partial<
    Pick<
      GpuixRenderer,
      | "setFrameWakeCallback"
      | "setSyncEventHandler"
      | "keyEventPending"
      | "startedLinksPending"
      | "stepStartedLinks"
      | "isWindowClosed"
    >
  >

interface FrameLoopMember {
  renderer: FrameLoopRenderer
  options: FrameLoopOptions
}

/** The windows of one App share one platform to pump, so they share one loop: it ticks the
 *  platform once per iteration, and services every renderer that registered (`startFrameLoop`). */
class SharedFrameLoop {
  private readonly members = new Set<FrameLoopMember>()
  /** The `onTerminated` of every renderer that was served, a renderer whose window closed earlier
   *  included: the app ending is news to the app, not to one window. */
  private readonly terminated = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private scheduledFrame: ReturnType<typeof setImmediate> | undefined
  private scheduledInputFrame: ReturnType<typeof setImmediate> | undefined
  private stopped = false
  /** The renderer the run-loop wake is installed on: the hook is the platform's, so one is
   *  enough, and it moves when its renderer leaves. */
  private wakeOwner: FrameLoopMember | undefined
  private readonly frameMs: number | undefined
  private frameWake = false

  constructor(first: FrameLoopMember) {
    this.frameMs = first.options.frameMs
    this.members.add(first)
    if (first.options.onTerminated) this.terminated.add(first.options.onTerminated)
    this.frameWake = this.installWake(first)
    // The first tick is a task of its own, after the code that follows startFrameLoop() and the
    // microtasks the mount queued (a promise-based positioner, an editor's commit), as a browser
    // paints after the task that built the page and its microtask checkpoint.
    this.scheduleLoop()
  }

  get isStopped(): boolean {
    return this.stopped
  }

  add(member: FrameLoopMember): void {
    this.members.add(member)
    if (member.options.onTerminated) this.terminated.add(member.options.onTerminated)
    // A new window has not been ticked yet, and nothing wakes an idle platform for it.
    this.scheduleLoop()
  }

  remove(member: FrameLoopMember): void {
    if (!this.members.delete(member)) return
    this.moveWake(member)
    if (this.members.size === 0) this.shutDown()
  }

  private installWake(member: FrameLoopMember): boolean {
    if (this.frameMs !== undefined) return false
    const installed = member.renderer.setFrameWakeCallback?.(this.wake) === true
    if (installed) this.wakeOwner = member
    return installed
  }

  /** `leaving` stops being the renderer the wake hangs on, if it was. */
  private moveWake(leaving: FrameLoopMember): void {
    if (this.wakeOwner !== leaving) return
    this.wakeOwner = undefined
    leaving.renderer.setFrameWakeCallback?.(null)
    const next = this.leader()
    if (next && this.frameWake && !this.stopped) this.frameWake = this.installWake(next)
  }

  private leader(): FrameLoopMember | undefined {
    for (const member of this.members) return member
    return undefined
  }

  private shutDown(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.scheduledFrame !== undefined) clearImmediate(this.scheduledFrame)
    this.scheduledFrame = undefined
    if (this.scheduledInputFrame !== undefined) clearImmediate(this.scheduledInputFrame)
    this.scheduledInputFrame = undefined
  }

  // The frame runs as its own task, not inside the wake callback: Bun and Node run I/O
  // and timers after the immediates phase, before the next wake's frame, while a threadsafe
  // function callback that ticks inline keeps Bun inside its dispatch loop.
  private readonly wake = (): void => {
    this.scheduleLoop()
  }

  private scheduleLoop(): void {
    if (this.stopped || this.scheduledFrame !== undefined) return
    this.scheduledFrame = setImmediate(() => {
      this.scheduledFrame = undefined
      this.loop()
    })
  }

  // The frame of an input draws from a task of its own, after the microtasks the tick's handlers
  // queued (an editor that commits its update in one, Lexical), as a browser paints after the input
  // task and its microtasks. Never from inside tick(), which pumps and draws no frame of its own.
  // Whether a link is owed is asked inside the immediate, not after the tick: a link only one of
  // those microtasks starts (a commit after a prevented edit) does not exist yet when tick() returns.
  // The display links belong to the platform, not to a window, so the leader asks for them.
  private scheduleInputFrame(): void {
    const leader = this.leader()
    if (!leader?.renderer.startedLinksPending || !leader.renderer.stepStartedLinks) return
    if (this.scheduledInputFrame !== undefined) return
    this.scheduledInputFrame = setImmediate(() => {
      this.scheduledInputFrame = undefined
      if (this.stopped) return
      const current = this.leader()
      if (!current) return
      try {
        if (current.renderer.startedLinksPending?.()) current.renderer.stepStartedLinks?.()
      } catch (error) {
        current.options.onError?.(error)
      }
    })
  }

  private loop(): void {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    const started = performance.now()
    const leader = this.leader()
    if (!leader) return
    // Writes made since the last flush reach native before the frame this tick draws: the leader's
    // own tick does that for its renderer.
    for (const member of this.members) {
      if (member !== leader) tickPreparers.get(member.renderer)?.()
    }
    let running = true
    try {
      running = leader.renderer.tick()
    } catch (error) {
      leader.options.onError?.(error)
    }
    if (running === false) {
      this.terminate()
      return
    }
    this.releaseClosedWindows()
    if (this.stopped) return
    this.scheduleInputFrame()
    // On the wake path nothing re-arms a timer: an idle app is not ticked until the run loop has work.
    if (this.frameWake) return
    // A tick that left a key queued runs one key per tick, so the next key waits for no timer.
    if (this.leader()?.renderer.keyEventPending?.()) {
      this.scheduledFrame = setImmediate(() => {
        this.scheduledFrame = undefined
        this.loop()
      })
      return
    }
    const delay = Math.max(0, (this.frameMs ?? DEFAULT_FRAME_MS) - (performance.now() - started))
    this.timer = setTimeout(() => this.loop(), delay)
  }

  /** The app goes on while another window is open, so a renderer whose window closed leaves the
   *  loop; the platform's own quit is the last window's, and `tick()` reports that. The last member
   *  never leaves here, even when its window is closed: the quit is queued and only the next
   *  `tick()` sees it, so an empty loop would never run `onTerminated`. Checked for each member,
   *  since a `pagehide` handler of one that leaves can close the window of the rest. */
  private releaseClosedWindows(): void {
    for (const member of [...this.members]) {
      if (this.members.size < 2) return
      if (!member.renderer.isWindowClosed?.()) continue
      this.members.delete(member)
      this.moveWake(member)
      member.renderer.setSyncEventHandler?.(null)
      releaseRenderer(member.renderer)
      try {
        member.options.onWindowClosed?.()
      } catch (error) {
        member.options.onError?.(error)
      }
    }
  }

  /** `tick()` said the platform quit: the last window closed, or the Dock, ⌘Q or a logout asked. */
  private terminate(): void {
    const members = [...this.members]
    this.members.clear()
    if (this.wakeOwner) {
      this.wakeOwner.renderer.setFrameWakeCallback?.(null)
      this.wakeOwner = undefined
    }
    this.shutDown()
    // The sync handler captures the renderer, so it has to be released for the renderer to be collectable.
    for (const member of members) {
      member.renderer.setSyncEventHandler?.(null)
      releaseRenderer(member.renderer)
    }
    flushStorage()
    for (const onTerminated of this.terminated) onTerminated()
  }
}

let sharedLoop: SharedFrameLoop | undefined

/** Registers `renderer` with the app's one frame loop, which it starts when it is the first. A
 *  second window's renderer joins the loop that is running: the platform is pumped once per
 *  iteration, and a window that closes leaves it (`onWindowClosed`) while the rest go on. The
 *  loop ends, and `onTerminated` runs once, when the platform quits. */
export function startFrameLoop(
  renderer: FrameLoopRenderer,
  options: FrameLoopOptions = {}
): FrameLoop {
  if (!renderer.requiresTick()) return { stop() {} }
  frameLoopOptions.set(renderer, options)
  const member: FrameLoopMember = { renderer, options }
  let loop = sharedLoop
  if (!loop || loop.isStopped) {
    loop = new SharedFrameLoop(member)
    sharedLoop = loop
  } else {
    loop.add(member)
  }
  const joined = loop
  return {
    stop() {
      joined.remove(member)
      if (joined.isStopped && sharedLoop === joined) sharedLoop = undefined
    },
  }
}

// The client pulls in zod and eventsource-parser, so an app that never turns
// automation on must not load it.
export async function enableAutomation(renderer: LiveAutomationRenderer): Promise<void> {
  const client = await import("./automation/client.js")
  client.serveAutomationStdio(new client.InProcessBackend(client.liveRendererAsTest(renderer)))
}

export async function installBrowserAutomation(
  renderer: LiveAutomationRenderer,
  existing?: App
): Promise<App> {
  if (existing) return existing
  const client = await import("./automation/client.js")
  return new client.App(new client.InProcessBackend(client.browserRendererAsTest(renderer)))
}
