/**
 * The part of `solid-js/web` that does not depend on its DOM renderer, built on Ghia's universal
 * renderer. The Solid plugin resolves `solid-js/web` here, so a Solid library that publishes its
 * JSX source (`Dynamic`, `Portal`, `isServer`) compiles and runs unchanged. The server-only API
 * (`getRequestEvent`, `NoHydration`, `renderToString`, ...) behaves as `solid-js/web`'s browser build does.
 * What only the DOM compiler's output calls (`template`, `setAttribute`, ...) is not exported:
 * the plugin reports a module that imports one of those.
 */
import {
  DEV,
  createEffect,
  createMemo,
  createRoot,
  getOwner,
  onCleanup,
  runWithOwner,
  splitProps,
  sharedConfig,
  untrack,
  type ComponentProps,
  type JSX,
  type Owner,
  type ValidComponent,
} from "solid-js"
import { document } from "@ghia/native/host"
import { isHostNode } from "./host.js"
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  memo,
  mergeProps,
  spread as spreadProps,
  universalRender,
  use,
} from "./universal.js"

export * from "solid-js"
export { createComponent, effect, insert, memo, mergeProps, use }

/**
 * Solid's web renderer's `render(code, element, init, options)`: mounts into `element` beside what it holds already, and
 * returns the dispose. Ghia's window-opening `render` is `@ghia/solid`'s. `document` runs the code without inserting its result.
 */
export function render(
  code: () => JSX.Element,
  element: Element | Document,
  init?: JSX.Element,
  options: { owner?: Owner | null } = {}
): () => void {
  if (element === (document as unknown)) {
    return createRoot((dispose) => {
      code()
      return dispose
    }, options.owner ?? undefined)
  }
  if (!isHostNode(element)) {
    throw new TypeError("render() mounts into an element of this window's document or into the document itself")
  }
  const dispose = universalRender(code, element, {
    marker: element.firstChild ? null : undefined,
    initial: init,
    owner: options.owner,
  })
  return () => {
    dispose()
    element.textContent = ""
  }
}

/** Solid's web renderer's signature; `isSVG` has nothing to select, as Ghia has no namespaces. */
export function spread(
  node: Parameters<typeof spreadProps>[0],
  props: Parameters<typeof spreadProps>[1],
  _isSVG?: boolean,
  skipChildren?: boolean
): Record<string, unknown> {
  return spreadProps(node, props, skipChildren)
}

export const isServer = false
// `DEV` is `undefined` in the production build of `solid-js`, which is how Solid's web renderer sets its own `isDev`.
export const isDev = DEV !== undefined

export type DynamicProps<T extends ValidComponent, P = ComponentProps<T>> = {
  [K in keyof P]: P[K]
} & {
  component: T | undefined
}

export function createDynamic<T extends ValidComponent>(
  component: () => T | undefined,
  props: ComponentProps<T>
): JSX.Element {
  const cached = createMemo(component)
  return createMemo(() => {
    const resolved = cached()
    switch (typeof resolved) {
      case "function":
        return untrack(() => (resolved as (props: ComponentProps<T>) => JSX.Element)(props))
      case "string": {
        const element = createElement(resolved)
        spreadProps(element, props)
        return element
      }
    }
  }) as unknown as JSX.Element
}

export function Dynamic<T extends ValidComponent>(props: DynamicProps<T>): JSX.Element {
  const split = splitProps(props, ["component"])
  return createDynamic(() => props.component, split[1] as ComponentProps<T>)
}

export type PortalProps = {
  /** The element the content is appended to; default `document.body` of the window's root. */
  mount?: Node
  /** Receives the container element the content is rendered in. */
  ref?: (container: HTMLElement) => void
  children: JSX.Element
  /** Accepted for `solid-js/web` compatibility; Ghia has no shadow roots. */
  useShadow?: boolean
  /** Accepted for `solid-js/web` compatibility; the container is always a `div`. */
  isSVG?: boolean
}

export function Portal(props: PortalProps): JSX.Element {
  const marker = createTextNode("")
  const owner = getOwner()
  let content: (() => JSX.Element) | undefined
  const contentMemo = () => {
    const memoized = runWithOwner(owner, () => createMemo(() => props.children))
    if (memoized === undefined) throw new Error("Portal's content was created outside its owner")
    return memoized
  }
  // A render effect, as in Solid's web renderer: the content is in place before a sibling's `onMount` or `createEffect` runs.
  createEffect(() => {
    content ||= contentMemo()
    const mount = (props.mount || document.body) as Node
    const container = createElement("div")
    insert(container, content)
    mount.appendChild(container as unknown as Node)
    props.ref?.(container as unknown as HTMLElement)
    onCleanup(() => {
      if (mount.contains(container as unknown as Node)) mount.removeChild(container as unknown as Node)
    })
  }, undefined, { render: true })
  return marker as unknown as JSX.Element
}

// What Solid's web renderer does in a browser with its server-only API, so a library written for both runs.
const voidFn = (..._args: unknown[]): undefined => undefined
export {
  voidFn as Assets,
  voidFn as HydrationScript,
  voidFn as generateHydrationScript,
  voidFn as getAssets,
  voidFn as getRequestEvent,
  voidFn as useAssets,
  voidFn as escape,
  voidFn as resolveSSRNode,
  voidFn as ssr,
  voidFn as ssrAttribute,
  voidFn as ssrClassList,
  voidFn as ssrElement,
  voidFn as ssrHydrationKey,
  voidFn as ssrSpread,
  voidFn as ssrStyle,
}

export const RequestContext = Symbol()

export function NoHydration(props: { children?: JSX.Element }): JSX.Element {
  return sharedConfig.context ? undefined : props.children
}

export function Hydration(props: { children?: JSX.Element }): JSX.Element {
  return props.children
}

export function getHydrationKey(): string {
  return sharedConfig.getNextContextId()
}

function throwInBrowser(func: { name: string }): void {
  console.error(new Error(`${func.name} is not supported in the browser, returning undefined`))
}

export function renderToString(..._args: unknown[]): undefined {
  throwInBrowser(renderToString)
}

export function renderToStringAsync(..._args: unknown[]): undefined {
  throwInBrowser(renderToStringAsync)
}

export function renderToStream(..._args: unknown[]): undefined {
  throwInBrowser(renderToStream)
}

/** The browser build hydrates server-rendered DOM; a Ghia window has none. */
export function hydrate(..._args: unknown[]): never {
  throw new Error("hydrate is not supported on Ghia: there is no server-rendered DOM to hydrate")
}

// Compiled JSX never produces the `$$click`-style delegated handlers these set up: every handler is attached to its element.
export function delegateEvents(_eventNames: string[], _document?: unknown): void {}

export function clearDelegatedEvents(_document?: unknown): void {}
