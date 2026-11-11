/** Removes the references in `refs` whose target was collected, and answers the first target still alive. */
export function pruneDeadRefs<T extends object>(refs: Set<WeakRef<T>>): T | undefined {
  let first: T | undefined
  for (const ref of refs) {
    const target = ref.deref()
    if (target === undefined) refs.delete(ref)
    else first ??= target
  }
  return first
}
