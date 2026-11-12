/**
 * How many batches of mutations have reached a renderer, across every queue. Internal to the
 * runtime: it moves whenever the tree changes, which makes it the signal that an app is still
 * working (`collectGarbageWhenIdle` waits for it to hold still), and it is not part of `host.ts`.
 */
let appliedBatches = 0

export function appliedBatchCount(): number {
  return appliedBatches
}

/** A batch reached a renderer. A queue notes its own; `showPopover()` writes one without a queue. */
export function noteBatchApplied(): void {
  appliedBatches++
}
