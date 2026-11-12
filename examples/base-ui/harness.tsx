import type { ReactNode } from 'react'
import { afterEach } from 'vitest'
import { createTestRoot } from '@ghia/react/testing'

type App = {
  root: ReturnType<typeof createTestRoot>
  renderer: ReturnType<typeof createTestRoot>['renderer']
}

const mounted: App[] = []

afterEach(() => {
  for (const app of mounted.splice(0)) app.root.unmount()
})

/** Renders `ui` in a window of its own; every app is unmounted after the test. */
export function mount(ui: ReactNode, size = { width: 640, height: 480 }): App {
  const root = createTestRoot(size)
  const app: App = { root, renderer: root.renderer }
  mounted.push(app)
  root.render(ui)
  return app
}

/** Lets timers, animation frames and the reconciler's follow-up renders run, as a user's pause does. */
export async function settle(app: App, milliseconds = 30): Promise<void> {
  for (let elapsed = 0; elapsed <= milliseconds; elapsed += 10) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Hands JS the events native queued meanwhile (a focus that a microtask moved).
    app.renderer.dispatchNativeEvents()
    app.renderer.advanceTime(10)
    app.renderer.drawFrame()
    app.renderer.flush()
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

/** The element whose text content is `text`, searching `selector` (every element by default). */
export function byText(text: string, selector = '*'): HTMLElement {
  const found = queryAll(selector).find(
    (element) => element.children.length === 0 && element.textContent === text,
  )
  if (found === undefined) throw new Error(`No ${selector} has the text "${text}"`)
  return found
}

export function center(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`<${element.localName}> has no box to point at`)
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** A real click: the pointer goes down and up over the element's center, through GPUI hit testing. */
export async function click(app: App, element: Element): Promise<void> {
  const point = center(element)
  app.renderer.nativeSimulateClick(point.x, point.y)
  await settle(app)
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
    await settle(app, 10)
  }
  await settle(app)
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
  if (active === null) return 'nothing is focused'
  return active.textContent === '' ? `<${active.localName}>` : (active.textContent ?? '')
}
