/**
 * The part of `solid-js/web` that does not depend on its DOM renderer, built on Ghia's universal
 * renderer. The Solid plugin resolves `solid-js/web` here, so a Solid library that publishes its
 * JSX source (`Dynamic`, `Portal`, `isServer`) compiles and runs unchanged. What only the DOM
 * compiler's output calls (`template`, `delegateEvents`, `setAttribute`, ...) is not exported:
 * the plugin reports a module that imports one of those.
 */
import {
  DEV,
  createEffect,
  createMemo,
  getOwner,
  onCleanup,
  runWithOwner,
  splitProps,
  untrack,
  type ComponentProps,
  type JSX,
  type ValidComponent,
} from "solid-js"
import { document } from "@ghia/native/host"
import {
  createComponent,
  createElement,
  createTextNode,
  effect,
  insert,
  memo,
  mergeProps,
  renderInto,
  spread as spreadProps,
  use,
} from "./universal.js"

export * from "solid-js"
export { createComponent, effect, insert, memo, mergeProps, use }

/** `solid-js/web`'s `render(code, element)`: mounts into `element` and returns the dispose. Ghia's window-opening `render` is `@ghia/solid`'s. */
export function render(code: () => JSX.Element, element: Element): () => void {
  const dispose = renderInto(code, element as never)
  return () => {
    dispose()
    element.textContent = ""
  }
}

/** `solid-js/web`'s signature; `isSVG` has nothing to select, as Ghia has no namespaces. */
export function spread(
  node: Parameters<typeof spreadProps>[0],
  props: Parameters<typeof spreadProps>[1],
  _isSVG?: boolean,
  skipChildren?: boolean
): void {
  spreadProps(node, props, skipChildren)
}

export const isServer = false
// `DEV` is `undefined` in the production build of `solid-js`, which is how `solid-js/web` sets its own `isDev`.
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
  // A render effect, as in `solid-js/web`: the content is in place before a sibling's `onMount` or `createEffect` runs.
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
