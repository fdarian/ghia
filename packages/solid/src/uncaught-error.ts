import type { RootEventHandlers } from "@ghia/native/host"

/** Reports an error no caller can handle to the root's `onUncaughtError`, or to `console.error` when it has none. */
export function reportUncaughtError(
  handlers: Pick<RootEventHandlers, "onUncaughtError">,
  thrown: unknown
): void {
  const error = thrown instanceof Error ? thrown : new Error(String(thrown))
  if (handlers.onUncaughtError) handlers.onUncaughtError(error, {})
  else console.error(error)
}
