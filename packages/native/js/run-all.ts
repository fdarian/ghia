function rethrow(failures: unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}

/**
 * Runs `run` on every item even when one throws, then rethrows: the error alone when one item
 * failed, an `AggregateError` of all of them when several did. A cleanup that stopped at the
 * first throw would leave the items after it unreleased.
 */
export function runAll<Item>(items: Iterable<Item>, run: (item: Item) => void, message: string): void {
  const failures: unknown[] = []
  for (const item of items) {
    try {
      run(item)
    } catch (error) {
      failures.push(error)
    }
  }
  rethrow(failures, message)
}

/** `runAll` for a list of unlike steps. */
export function runSteps(steps: Array<() => void>, message: string): void {
  runAll(steps, (step) => step(), message)
}

/**
 * Returns what `body` returns, then runs `after`. `after` also runs when `body` throws, and an
 * error from each is kept: one alone as it was, both as an `AggregateError`. A plain
 * `try { body() } finally { after() }` loses the first error when `after` throws too.
 */
export function runThenAlways<Result>(body: () => Result, after: () => void, message: string): Result {
  const failures: unknown[] = []
  let result: { value: Result } | undefined
  try {
    result = { value: body() }
  } catch (error) {
    failures.push(error)
  }
  try {
    after()
  } catch (error) {
    failures.push(error)
  }
  rethrow(failures, message)
  if (!result) throw new Error("unreachable: body neither returned nor threw")
  return result.value
}
