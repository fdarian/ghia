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
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}
