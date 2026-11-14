import { createMemo, createRenderEffect } from "solid-js"

interface SpreadHost<Node> {
  insert(parent: Node, accessor: unknown): unknown
  setProperty(node: Node, name: string, value: unknown, previous: unknown): void
}

type Props = Record<string, unknown>

/**
 * `spread` of `solid-js/universal`, which only visits the keys a spread has now, so a key that left it
 * (`{...(open() ? { "data-open": "" } : {})}`) keeps its last value. Solid's DOM renderer takes it away; this
 * does the same, by writing `undefined` over it.
 */
export function createSpread<Node>(host: SpreadHost<Node>) {
  function spreadExpression(node: Node, props: Props | undefined, prevProps: Props = {}): Props {
    const next = props ?? {}
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
      // One insert for the node's life: it keeps what it inserted, so a new value replaces the old nodes.
      // Inserting inside the effect below would start from nothing each time `accessor` re-runs.
      const props = createMemo(accessor)
      if (!skipChildren) host.insert(node, () => props()?.children)
      createRenderEffect((current: Props | undefined) => spreadExpression(node, props(), current))
    } else {
      if (!skipChildren) host.insert(node, () => accessor?.children)
      spreadExpression(node, accessor)
    }
  }
}
