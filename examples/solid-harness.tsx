import type { JSX } from 'solid-js'
import { afterEach } from 'vitest'
import { createTestRoot } from '@ghia/solid/testing'

type App = {
  root: ReturnType<typeof createTestRoot>
  renderer: ReturnType<typeof createTestRoot>['renderer']
}

const mounted: App[] = []

afterEach(() => {
  for (const app of mounted.splice(0)) app.root.unmount()
})

/** Renders `ui` in a window of its own; every app is unmounted after the test. */
export function mount(ui: () => JSX.Element, size = { width: 640, height: 480 }): App {
  const root = createTestRoot(size)
  const app: App = { root, renderer: root.renderer }
  mounted.push(app)
  root.render(ui)
  return app
}

/**
 * One turn of the event loop and one frame: the timers and promise chains that were due run, native hands JS the
 * events it queued meanwhile (a focus that a microtask moved), and the display link steps once. No wall-clock time
 * passes, so a commit that only lands after `settle` is asynchronous in an app too.
 */
export async function settle(app: App): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  app.renderer.dispatchNativeEvents()
  app.renderer.advanceTime(10)
  app.renderer.drawFrame()
  app.renderer.flush()
}

/** Real time passing, as a delay in the library under test does (a tooltip's open delay is a JS timer), a frame at a time. */
export async function wait(app: App, milliseconds: number): Promise<void> {
  const end = performance.now() + milliseconds
  while (performance.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    await settle(app)
  }
}

/** The first element in the document that matches, or a failure naming the selector. */
export function query(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector)
  if (element === null) throw new Error(`Nothing in the document matches ${selector}`)
  return element
}

export function queryAll(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
}

export function exists(selector: string): boolean {
  return document.querySelector(selector) !== null
}

/** Whether something matching `selector` is in the document and takes up room, which a `hidden` element does not. */
export function isShown(selector: string): boolean {
  const element = document.querySelector(selector)
  if (element === null) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** The deepest element of `selector` (every element by default) whose text content is `text`. */
export function byText(text: string, selector = '*'): HTMLElement {
  const matching = queryAll(selector).filter((element) => element.textContent === text)
  const deepest = matching.find((element) => !matching.some((other) => other !== element && element.contains(other)))
  if (deepest === undefined) throw new Error(`No ${selector} has the text "${text}"`)
  return deepest
}

export function center(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`<${element.localName}> has no box to point at`)
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/**
 * A real click: the pointer goes down, stays for a frame (libraries tell one press from the next with zero-delay
 * timers, and a person's press lasts longer than a turn of the event loop), and comes up, over the point.
 */
export async function clickAt(app: App, x: number, y: number): Promise<void> {
  app.renderer.nativeSimulateMouseDown(x, y)
  await settle(app)
  app.renderer.nativeSimulateMouseUp(x, y)
  await settle(app)
}

export async function click(app: App, element: Element): Promise<void> {
  const point = center(element)
  await clickAt(app, point.x, point.y)
}

export async function hover(app: App, element: Element): Promise<void> {
  const point = center(element)
  app.renderer.nativeSimulateMouseMove(point.x, point.y)
  await settle(app)
}

/** Moves the pointer to a point with nothing of the app under it. */
export async function hoverNothing(app: App): Promise<void> {
  app.renderer.nativeSimulateMouseMove(1, 1)
  await settle(app)
}

/**
 * Presses keys on whatever holds focus (Playwright's grammar: `"ArrowDown"`, `"Shift+Tab"`, `"a Enter"`), one
 * at a time with the events of each delivered before the next, as a person's keys are.
 */
export async function press(app: App, keys: string): Promise<void> {
  for (const key of keys.split(' ')) {
    app.renderer.simulateKeystrokes(key)
    await settle(app)
  }
}

export async function focus(app: App, element: HTMLElement): Promise<void> {
  element.focus()
  await settle(app)
}

/** `[{ x, y, width, height }]` of an element, as laid out. */
export function box(element: Element): DOMRect {
  return element.getBoundingClientRect()
}

/** The text of the element that holds focus, or its tag when it has none: what a failed focus assertion should print. */
export function activeText(): string {
  const active = document.activeElement
  if (active === document.body) return 'nothing is focused (<body>)'
  return active.textContent || `<${active.localName}>`
}
