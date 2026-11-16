import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { hasNativeTestRenderer } from '@ghia/native/testing'
import { measure, scenarios, type Counts } from './scenarios'

type CountsFile = { macos: string; scenarios: Record<string, Counts> }
type Change = { field: string; expected: number | undefined; actual: number | undefined }

/** The counts are exact: any difference fails, in either direction, and `PERF_GATE_UPDATE=1` rewrites them. */
const EXPECTED_PATH = new URL('./expected-counts.json', import.meta.url)
/** Every run writes what it measured here, in the shape of the expected file, so CI can upload it. */
const MEASURED_PATH = new URL('./.measured.json', import.meta.url)
const UPDATE = process.env.PERF_GATE_UPDATE === '1'

/** What the primitives of painted text come to depends on what CoreText returns, which changes between macOS releases (a CI
 *  runner and a laptop on different versions differ by a few primitives). The expected file records the macOS version it was
 *  measured on, and these fields are compared only on that version. */
const MACOS_TIED_FIELDS = ['frameWork.paintedPrimitives', 'frameWork.replayedPrimitives']

function refuseUnlessReproducible() {
  if (!hasNativeTestRenderer) throw new Error('perf gate: the native addon was built without test-support')
  const gpuix = Object.keys(process.env).filter((name) => name.startsWith('GPUIX_'))
  if (gpuix.length > 0) throw new Error(`perf gate: ${gpuix.join(', ')} change what the engine does; unset them`)
  if (process.env.SEED !== undefined) throw new Error('perf gate: SEED is set; unset it')
  if (process.env.NODE_ENV !== 'production') throw new Error('perf gate: run it as `bun run test:perf-gate`, which sets NODE_ENV=production')
}

refuseUnlessReproducible()

const macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()

function readExpected(): CountsFile | undefined {
  if (!existsSync(EXPECTED_PATH)) return undefined
  return JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) as CountsFile
}

const expected = readExpected()
const measured: Record<string, Counts> = {}
const failed = new Set<string>()

function changes(before: Counts, after: Counts, skip: string[]): Change[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
  const rows: Change[] = []
  for (const field of fields) {
    if (skip.includes(field)) continue
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

function table(title: string, columns: [string, string], rows: Change[]): string {
  const cells = rows.map((row) => [row.field, String(row.expected ?? '-'), String(row.actual ?? '-'), delta(row)])
  const header = ['field', columns[0], columns[1], 'delta']
  const widths = header.map((_, column) => Math.max(...[header, ...cells].map((line) => line[column].length)))
  const line = (values: string[]) => values.map((value, column) => (column === 0 ? value.padEnd(widths[column]) : value.padStart(widths[column]))).join('  ')
  return [title, `  ${line(header)}`, ...cells.map((values) => `  ${line(values)}`)].join('\n')
}

function measureTwice(name: string, scenario: (typeof scenarios)[number]): Counts {
  // A window's first build in the process counts differently (mount computed 2 style applies more, which a later window
  // replays: a process-wide cache is cold), so the counts would depend on which scenario ran before it. A run nobody reads
  // warms that up.
  measure(scenario)
  const first = measure(scenario)
  const second = measure(scenario)
  const unstable = changes(first, second, [])
  if (unstable.length > 0) {
    throw new Error(`perf gate: ${name} measured different counts in two fresh windows\n${table(name, ['first', 'second'], unstable)}`)
  }
  return first
}

function compare(name: string, counts: Counts) {
  if (!expected) throw new Error('perf gate: expected-counts.json does not exist (PERF_GATE_UPDATE=1 writes it)')
  const wanted = expected.scenarios[name]
  if (!wanted) throw new Error(`perf gate: ${name} has no counts in expected-counts.json (PERF_GATE_UPDATE=1 adds it)`)
  const skip = expected.macos === macos ? [] : MACOS_TIED_FIELDS
  const rows = changes(wanted, counts, skip)
  if (rows.length > 0) {
    throw new Error(`perf gate: ${name} differs from expected-counts.json (PERF_GATE_UPDATE=1 accepts the new counts)\n${table(name, ['expected', 'actual'], rows)}`)
  }
}

function mergedForUpdate(): CountsFile {
  const keepRecorded = expected !== undefined && expected.macos !== macos
  const next: CountsFile = { macos: keepRecorded ? expected.macos : macos, scenarios: {} }
  for (const scenario of scenarios) {
    const counts = { ...measured[scenario.name] }
    if (keepRecorded) {
      const recorded = expected.scenarios[scenario.name]
      for (const field of MACOS_TIED_FIELDS) {
        if (!recorded || !(field in recorded)) {
          throw new Error(
            `perf gate: ${scenario.name} is new, and ${field} depends on the macOS version (file: ${expected.macos}, here: ${macos}); take the counts from a CI run on the file's macOS`,
          )
        }
        counts[field] = recorded[field]
      }
    }
    next.scenarios[scenario.name] = counts
  }
  return next
}

function reportUpdate(next: CountsFile) {
  const lines: string[] = []
  if (expected && expected.macos !== macos) {
    lines.push(`this is macOS ${macos} and the file was measured on ${expected.macos}: ${MACOS_TIED_FIELDS.join(' and ')} and "macos" kept from the file`)
  }
  for (const name of Object.keys(next.scenarios)) {
    const previous = expected?.scenarios[name]
    if (!previous) lines.push(`${name}: new scenario`)
    else {
      const rows = changes(previous, next.scenarios[name], [])
      if (rows.length > 0) lines.push(table(name, ['before', 'after'], rows))
    }
  }
  if (expected) {
    for (const name of Object.keys(expected.scenarios)) {
      if (!(name in next.scenarios)) lines.push(`${name}: scenario removed`)
    }
  }
  console.log(`perf gate: expected-counts.json rewritten\n${lines.length > 0 ? lines.join('\n') : 'no count changed'}`)
}

describe('perf gate', () => {
  beforeAll(() => {
    if (!UPDATE && expected && expected.macos !== macos) {
      console.log(
        `perf gate: macOS ${macos} here, expected-counts.json was measured on ${expected.macos}; ${MACOS_TIED_FIELDS.join(' and ')} are not compared`,
      )
    }
  })

  // Skipped with the scenarios by a -t filter, which is what lets a filtered run pass without every scenario of the file.
  it('expected-counts.json names only scenarios that exist', () => {
    if (UPDATE) return
    if (!expected) throw new Error('perf gate: expected-counts.json does not exist (PERF_GATE_UPDATE=1 writes it)')
    const known = scenarios.map((scenario) => scenario.name)
    const stale = Object.keys(expected.scenarios).filter((name) => !known.includes(name))
    if (stale.length > 0) throw new Error(`perf gate: expected-counts.json has counts for scenarios that no longer exist: ${stale.join(', ')}`)
  })

  for (const scenario of scenarios) {
    it(scenario.name, () => {
      try {
        const counts = measureTwice(scenario.name, scenario)
        measured[scenario.name] = counts
        if (!UPDATE) compare(scenario.name, counts)
      } catch (error) {
        failed.add(scenario.name)
        throw error
      }
    })
  }

  afterAll(() => {
    writeFileSync(MEASURED_PATH, `${JSON.stringify({ macos, scenarios: measured }, null, 2)}\n`)
    if (!UPDATE) return
    const missing = scenarios.filter((scenario) => !(scenario.name in measured)).map((scenario) => scenario.name)
    if (missing.length > 0 || failed.size > 0) {
      throw new Error(
        `perf gate: refusing to rewrite expected-counts.json; every scenario has to run (a -t filter skips some) and none may fail. Not measured: ${missing.join(', ') || 'none'}. Failed: ${[...failed].join(', ') || 'none'}`,
      )
    }
    const next = mergedForUpdate()
    writeFileSync(EXPECTED_PATH, `${JSON.stringify(next, null, 2)}\n`)
    reportUpdate(next)
  })
})
