/**
 * A number that changes whenever a node is placed in or taken out of a tree, a window root mounts
 * or unmounts, or an attribute is written. A live list (`getElementsByTagName` and the others) keeps
 * the elements it found until the number moves, so a loop over `length` and indices searches once.
 *
 * One number for the whole document, not one per subtree: the writers are the adapters' own
 * insert, remove and prop paths, which know their node and not every list that watches it.
 */

const KEY = Symbol.for("@ghia/native/tree-version")

type Counter = { version: number }

/** On `globalThis` like the DOM classes: a second copy of this package must read the counter the adapter bumps. */
const counter: Counter = (() => {
  const existing = Reflect.get(globalThis, KEY) as Counter | undefined
  if (existing) return existing
  const created: Counter = { version: 0 }
  Reflect.set(globalThis, KEY, created)
  return created
})()

export function treeVersion(): number {
  return counter.version
}

export function bumpTreeVersion(): void {
  counter.version += 1
}
