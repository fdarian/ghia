import type { Element, Node } from "../nodes.js"
import { InertDocument, type InertFragment } from "./inert-nodes.js"
import { parse5 } from "./parse5.js"
import { createTreeAdapter } from "./tree-adapter.js"

/** What `DOMParser` makes of `text` as `text/html`: scripting is off in a parsed document, so `<noscript>` has elements. */
export function parseHtmlDocument(text: string): InertDocument {
  const document = new InertDocument()
  parse5().parse(text, { treeAdapter: createTreeAdapter(document), scriptingEnabled: false })
  return document
}

/** The nodes `text` makes where `context` is the element they would be set in (`innerHTML`'s "context element"). */
export function parseHtmlFragment(context: Element, text: string): InertFragment {
  const document = new InertDocument()
  return parse5().parseFragment(context, text, { treeAdapter: createTreeAdapter(document) }) as unknown as InertFragment
}

/** Reads only, so the document it is made over holds nothing. */
let reader: ReturnType<typeof createTreeAdapter> | undefined

function readingAdapter(): ReturnType<typeof createTreeAdapter> {
  reader ??= createTreeAdapter(new InertDocument())
  return reader
}

/** The markup of the children of `node`: `innerHTML`. */
export function serializeChildren(node: Node): string {
  return parse5().serialize(node, { treeAdapter: readingAdapter() })
}

/** The markup of `node` itself and what is in it: `outerHTML`. */
export function serializeNode(node: Node): string {
  return parse5().serializeOuter(node, { treeAdapter: readingAdapter() })
}
