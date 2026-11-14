import { createRenderEffect } from "solid-js"

interface SpreadHost<Node> {
  insert(parent: Node, accessor: unknown, marker?: undefined, initial?: unknown): unknown
  setProperty(node: Node, name: string, value: unknown, previous: unknown): void
}

type Props = Record<string, unknown>

/**
 * `spread` of `solid-js/universal`, which only visits the keys a spread has now, so a key that left it
 * (`{...(open() ? { "data-open": "" } : {})}`) keeps its last value. Solid's DOM renderer takes it away; this
 * does the same, by writing `undefined` over it.
 */
export function createSpread<Node>(host: SpreadHost<Node>) {
  function spreadExpression(node: Node, props: Props | undefined, prevProps: Props = {}, skipChildren?: boolean): Props {
    const next = props ?? {}
    if (!skipChildren) {
      createRenderEffect(() => {
        prevProps.children = host.insert(node, next.children, undefined, prevProps.children)
      })
    }
    createRenderEffect(() => {
      if (next.ref) (next.ref as (node: Node) => void)(node)
    })
    createRenderEffect(() => {
      for (const name of Object.keys(prevProps)) {
        if (name === "children" || name === "ref" || name in next) continue
        host.setProperty(node, name, undefined, prevProps[name])
        delete prevProps[name]
      }
      for (const name in next) {
        if (name === "children" || name === "ref") continue
        const value = next[name]
        if (value === prevProps[name]) continue
        host.setProperty(node, name, value, prevProps[name])
        prevProps[name] = value
      }
    })
    return prevProps
  }

  return function spread(node: Node, accessor: Props | (() => Props | undefined) | undefined, skipChildren?: boolean): void {
    if (typeof accessor === "function") {
      createRenderEffect((current: Props | undefined) => spreadExpression(node, accessor(), current, skipChildren))
    } else spreadExpression(node, accessor, undefined, skipChildren)
  }
}
