import { existsSync, readFileSync } from 'node:fs'
import type { Counts } from './scenarios'

export type CountsFile = {
  /** Every field of a scenario except the tied ones. */
  scenarios: Record<string, Counts>
  /** macOS version -> scenario -> the tied fields measured on that version. */
  tied: Record<string, Record<string, Counts>>
}
type Change = { field: string; expected: number | undefined; actual: number | undefined }

export const EXPECTED_PATH = new URL('./expected-counts.json', import.meta.url)

/** What the primitives of painted text come to depends on what CoreText returns, which changes between macOS releases (a CI
 *  runner and a laptop on different versions differ by a few primitives). These are recorded per macOS version. */
const TIED_FIELDS = ['frameWork.paintedPrimitives', 'frameWork.replayedPrimitives']

export function readExpected(): CountsFile | undefined {
  if (!existsSync(EXPECTED_PATH)) return undefined
  return JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) as CountsFile
}

export function splitCounts(name: string, counts: Counts): { fixed: Counts; tied: Counts } {
  const fixed: Counts = { ...counts }
  const tied: Counts = {}
  for (const field of TIED_FIELDS) {
    if (!(field in counts)) throw new Error(`perf gate: ${name} has no ${field}`)
    tied[field] = counts[field]
    delete fixed[field]
  }
  return { fixed, tied }
}

export function changes(before: Counts, after: Counts): Change[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows: Change[] = []
  for (const field of fields) {
    const left = before[field]
    const right = after[field]
    if (left !== right) rows.push({ field, expected: left, actual: right })
  }
  return rows
}

function delta(row: Change): string {
  if (row.expected === undefined) return 'new field'
  if (row.actual === undefined) return 'field gone'
  const change = row.actual - row.expected
  if (!Number.isFinite(change)) throw new Error(`${row.field}: ${row.expected} -> ${row.actual} has no finite delta`)
  return change > 0 ? `+${change}` : String(change)
}

export function table(title: string, columns: [string, string], rows: Change[]): string {
  const cells = rows.map((row) => [row.field, String(row.expected ?? '-'), String(row.actual ?? '-'), delta(row)])
  const header = ['field', columns[0], columns[1], 'delta']
  const widths = header.map((_, column) => Math.max(...[header, ...cells].map((line) => line[column].length)))
  const line = (values: string[]) => values.map((value, column) => (column === 0 ? value.padEnd(widths[column]) : value.padStart(widths[column]))).join('  ')
  return [title, `  ${line(header)}`, ...cells.map((values) => `  ${line(values)}`)].join('\n')
}

/**
 * Throws when the counts differ from the file. The tied fields are compared exactly against this macOS version's entry. A version
 * without an entry is compared against every recorded one (a point release of a version CI already measured), and passes when
 * they equal one of them: the return value is that version, for the caller to warn about.
 */
export function compareToExpected(expected: CountsFile, macos: string, name: string, counts: Counts): string | undefined {
  const wanted = expected.scenarios[name]
  if (!wanted) throw new Error(`perf gate: ${name} has no counts in expected-counts.json (PERF_GATE_UPDATE=1 adds it)`)
  const split = splitCounts(name, counts)
  const problems: string[] = []
  const fixedRows = changes(wanted, split.fixed)
  if (fixedRows.length > 0) problems.push(table(name, ['expected', 'actual'], fixedRows))

  let sameAs: string | undefined
  const own = expected.tied[macos]
  if (own) {
    const entry = own[name]
    if (!entry) {
      problems.push(`${name} has no tied counts for macOS ${macos} in expected-counts.json (PERF_GATE_UPDATE=1 adds them here; CI's come from the perf-gate-measured artifact)`)
    } else {
      const rows = changes(entry, split.tied)
      if (rows.length > 0) problems.push(table(`${name}, tied fields on macOS ${macos}`, ['expected', 'actual'], rows))
    }
  } else {
    const recorded = Object.entries(expected.tied).filter((entry) => name in entry[1])
    const match = recorded.find((entry) => changes(entry[1][name], split.tied).length === 0)
    if (match) sameAs = match[0]
    else if (recorded.length === 0) problems.push(`${name} has no tied counts for any macOS in expected-counts.json (PERF_GATE_UPDATE=1 adds them)`)
    else {
      for (const entry of recorded) {
        problems.push(table(`${name}, tied fields on macOS ${macos}, which has no entry (compared with macOS ${entry[0]})`, [`macOS ${entry[0]}`, 'actual'], changes(entry[1][name], split.tied)))
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`perf gate: ${name} differs from expected-counts.json (PERF_GATE_UPDATE=1 accepts the new counts)\n${problems.join('\n')}`)
  }
  return sameAs
}
