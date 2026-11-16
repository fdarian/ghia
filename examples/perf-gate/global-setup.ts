import { appendFileSync, writeFileSync } from 'node:fs'
import { EXPECTED_PATH, readExpected, type CountsFile } from './counts-file'
import { PART_NAMES, MEASURED_DIR, clearParts, measuredFile, readPart, rewrite, type Part } from './measured'
import type { Counts } from './scenarios'

const UPDATE = process.env.PERF_GATE_UPDATE === '1'
const onCI = process.env.CI !== undefined && process.env.CI !== ''

export function setup() {
  clearParts()
}

/**
 * Runs in the main process after every test file, which is the one place that sees all of them. vitest prints an error thrown
 * from a teardown and still exits 0, so a failure here sets the exit code itself.
 */
export function teardown() {
  try {
    finish()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

function finish() {
  const present = PART_NAMES.flatMap((name) => {
    const part = readPart(name)
    return part ? [{ name, part }] : []
  })
  const missingFiles = PART_NAMES.filter((name) => !present.some((entry) => entry.name === name))
  if (present.length === 0) {
    if (UPDATE) throw new Error('perf gate: refusing to rewrite expected-counts.json; no test file wrote what it measured')
    return
  }
  const macos = present[0].part.macos
  if (present.some((entry) => entry.part.macos !== macos)) throw new Error('perf gate: the test files ran on different macOS versions')

  const names = present.flatMap((entry) => entry.part.names)
  const counts: Record<string, Counts> = {}
  for (const entry of present) Object.assign(counts, entry.part.counts)
  writeFileSync(new URL('counts.json', MEASURED_DIR), `${JSON.stringify(measuredFile(macos, names, counts), null, 2)}\n`)

  const expected = readExpected()
  if (UPDATE) {
    update(expected, macos, names, counts, present.map((entry) => entry.part), missingFiles)
    return
  }
  reportSameAs(macos, present.flatMap((entry) => entry.part.sameAs))
  if (missingFiles.length === 0 && expected) {
    const stale = Object.keys(expected.scenarios).filter((name) => !names.includes(name))
    if (stale.length > 0) throw new Error(`perf gate: expected-counts.json has counts for scenarios that no longer exist: ${stale.join(', ')}`)
  }
}

function update(expected: CountsFile | undefined, macos: string, names: string[], counts: Record<string, Counts>, parts: Part[], missingFiles: string[]) {
  const notMeasured = names.filter((name) => !(name in counts))
  const failed = parts.flatMap((part) => part.failed)
  if (missingFiles.length > 0 || notMeasured.length > 0 || failed.length > 0) {
    throw new Error(
      `perf gate: refusing to rewrite expected-counts.json; every scenario of both test files has to run (a -t filter or a file filter skips some) and none may fail. Files that wrote nothing: ${missingFiles.join(', ') || 'none'}. Not measured: ${notMeasured.join(', ') || 'none'}. Failed: ${failed.join(', ') || 'none'}`,
    )
  }
  const result = rewrite(expected, macos, names, counts)
  writeFileSync(EXPECTED_PATH, `${JSON.stringify(result.next, null, 2)}\n`)
  console.log(
    `perf gate: expected-counts.json rewritten: non-tied fields from this run, tied fields only under macOS ${macos}, other versions' entries kept\n${result.report.length > 0 ? result.report.join('\n') : 'no count changed'}`,
  )
}

function reportSameAs(macos: string, versions: string[]) {
  if (versions.length === 0) return
  const same = [...new Set(versions)].join(', ')
  const message = `macOS ${macos} has no entry in expected-counts.json; its tied counts equal macOS ${same}'s, so the gate passes. Add "${macos}" under "tied" from the perf-gate-measured artifact (counts.json).`
  console.warn(`perf gate: ${message}`)
  if (!onCI) return
  console.log(`::warning title=Perf gate::${message}`)
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `### Perf gate: macOS ${macos} has no recorded entry\n\n${message}\n`)
}
