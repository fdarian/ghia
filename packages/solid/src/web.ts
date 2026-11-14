/**
 * The part of `solid-js/web` that does not depend on its DOM renderer, built on Ghia's universal
 * renderer. The Solid plugin resolves `solid-js/web` here, so a Solid library that publishes its
 * JSX source (`Dynamic`, `Portal`, `isServer`) compiles and runs unchanged. What only the DOM
 * compiler's output calls (`template`, `delegateEvents`, `setAttribute`, ...) is not exported:
 * the plugin reports a module that imports one of those.
 */
import {
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
import { createComponent, createElement, createTextNode, effect, insert, memo, mergeProps, spread, use } from "./universal.js"
import { render } from "./renderer.js"

export * from "solid-js"
export { createComponent, effect, insert, memo, mergeProps, render, spread, use }

export const isServer = false
export const isDev = false

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
        spread(element, props)
        return element
      }
    }
  }) as unknown as JSX.Element
}

export function Dynamic<T extends ValidComponent>(props: DynamicProps<T>): JSX.Element {
  const [, others] = splitProps(props, ["component"])
  return createDynamic(() => props.component, others as ComponentProps<T>)
}

export interface PortalProps {
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
  createEffect(() => {
    content ||= runWithOwner(owner, () => createMemo(() => props.children))!
    const mount: Node = props.mount || document.body
    const container = createElement("div")
    insert(container, content)
    mount.appendChild(container as unknown as Node)
    props.ref?.(container as unknown as HTMLElement)
    onCleanup(() => {
      if (mount.contains(container as unknown as Node)) mount.removeChild(container as unknown as Node)
    })
  })
  return marker as unknown as JSX.Element
}
