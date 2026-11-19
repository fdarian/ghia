/**
 * What marks a node of a parsed document (`DOMParser`), so the tree algorithms can tell it from a
 * node of a window without importing the classes, which load after them.
 */

export const INERT_DOCUMENT: unique symbol = Symbol.for("@ghia/native/inert-document")

/** The parsed document a node belongs to, or `undefined` for a node of a window. */
export function inertDocumentOf(node: object): object | undefined {
  return Reflect.get(node, INERT_DOCUMENT) as object | undefined
}
