import type { HotPayload } from "vite"
import type { ModuleRunner } from "vite/module-runner"

export type FullReloadPayload = Extract<HotPayload, { type: "full-reload" }>

/** Runs the steps one at a time, in the order they were queued; a failing step is logged and the next one still runs. */
export function createSerialQueue(): (step: () => Promise<void>) => void {
  let queue = Promise.resolve()
  return (step) => {
    queue = queue.then(step).catch((error) => console.error(error))
  }
}

export interface FullReloadOptions {
  enqueue: (step: () => Promise<void>) => void
  runner: () => ModuleRunner
  /** Runs before the runner's caches are cleared, with the modules of the old run still loaded. */
  stop?: () => void
  /** Evaluates the entry again. */
  start: () => Promise<void>
}

/**
 * Ghia's own handling of a `full-reload` payload, for a runner whose entry has to run again. The
 * runner's default re-imports the entry after `evaluatedModules.clear()` only, so the HMR client
 * keeps the hot data of the old run: a library that keeps its first registry there (solid-refresh)
 * then patches a dead tree after the reload, and the old run's modules stay reachable.
 * `clearCache()` drops both. Like the runner's default, it skips a payload whose `triggeredBy` file
 * is not in the runner's module graph.
 */
export function createFullReload(options: FullReloadOptions): (payload: FullReloadPayload) => void {
  return (payload) => {
    options.enqueue(async () => {
      const runner = options.runner()
      if (payload.triggeredBy && !runner.evaluatedModules.getModulesByFile(payload.triggeredBy.replaceAll("\\", "/"))?.size) return
      await runner.hmrClient?.notifyListeners("vite:beforeFullReload", payload)
      options.stop?.()
      runner.clearCache()
      await options.start()
    })
  }
}
