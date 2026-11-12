import { runAll } from "./run-all.js"

/**
 * Kept on `globalThis`: `ghia dev` unmounts the roots from its own copy of this module after a
 * save, while the adapter that registered them was evaluated by the module runner it is about to
 * clear.
 */
const ROOTS_KEY = Symbol.for("@ghia/native/roots")
const roots: Set<() => void> = (() => {
  const existing = Reflect.get(globalThis, ROOTS_KEY) as Set<() => void> | undefined
  if (existing) return existing
  const created = new Set<() => void>()
  Reflect.set(globalThis, ROOTS_KEY, created)
  return created
})()

/** @internal An adapter's root tells the runtime how to unmount it; the returned function forgets it again. */
export function registerRoot(unmount: () => void): () => void {
  roots.add(unmount)
  return () => {
    roots.delete(unmount)
  }
}

/**
 * Unmounts every mounted root and keeps its window, as `render()` does before it mounts again.
 * `ghia dev` calls it before a full reload runs the entry again, so what the entry writes to
 * `document` before `render()` lands on the stand-ins and carries to the new root, as it does after
 * a page reload, instead of on the `<html>` and `<body>` of the root that is about to go.
 */
export function unmountAllRoots(): void {
  runAll([...roots], (unmount) => unmount(), "Unmounting the roots failed")
}
