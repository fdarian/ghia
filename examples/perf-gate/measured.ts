import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { changes, splitCounts, table, type CountsFile } from './counts-file'
import type { Counts } from './scenarios'

/** What one test file measured, written when the file ends and read by the global setup's teardown once every file has run. */
export type Part = {
  macos: string
  /** Every scenario of the file, measured or not, so a run filtered with `-t` is known to be incomplete. */
  names: string[]
  counts: Record<string, Counts>
  failed: string[]
  /** macOS versions whose tied counts this run's equalled while this macOS had no entry of its own. */
  sameAs: string[]
}

/** Each test file is one part; both have to run for `PERF_GATE_UPDATE=1` to rewrite the file. */
export const PART_NAMES = ['perf-gate', 'cold-mount']

/** Uploaded by CI as the perf-gate-measured artifact. */
export const MEASURED_DIR = new URL('./.measured/', import.meta.url)
const partPath = (name: string) => new URL(`${name}.json`, MEASURED_DIR)

export function clearParts() {
  rmSync(MEASURED_DIR, { recursive: true, force: true })
  mkdirSync(MEASURED_DIR, { recursive: true })
}

export function writePart(name: string, part: Part) {
  mkdirSync(MEASURED_DIR, { recursive: true })
  writeFileSync(partPath(name), `${JSON.stringify(part, null, 2)}\n`)
}

export function readPart(name: string): Part | undefined {
  if (!existsSync(partPath(name))) return undefined
  return JSON.parse(readFileSync(partPath(name), 'utf8')) as Part
}

/** The measured counts in the shape of the expected file, with this macOS as the only version under `tied`. */
export function measuredFile(macos: string, names: string[], counts: Record<string, Counts>): CountsFile {
  const file: CountsFile = { scenarios: {}, tied: { [macos]: {} } }
  for (const name of names) {
    if (!(name in counts)) continue
    const split = splitCounts(name, counts[name])
    file.scenarios[name] = split.fixed
    file.tied[macos][name] = split.tied
  }
  return file
}

/**
 * The next expected file: every scenario's non-tied fields from this run and its tied fields under this macOS only. Other
 * versions' entries are copied as they are (scenarios that no longer exist dropped), because only a run on that version can
 * measure them.
 */
export function rewrite(expected: CountsFile | undefined, macos: string, names: string[], counts: Record<string, Counts>): { next: CountsFile; report: string[] } {
  const before: CountsFile = expected ?? { scenarios: {}, tied: {} }
  const measured = measuredFile(macos, names, counts)
  const next: CountsFile = { scenarios: {}, tied: {} }
  const report: string[] = []

  for (const name of names) {
    next.scenarios[name] = measured.scenarios[name]
    const recorded = before.scenarios[name]
    if (!recorded) report.push(`${name}: new scenario`)
    else {
      const rows = changes(recorded, measured.scenarios[name])
      if (rows.length > 0) report.push(table(name, ['before', 'after'], rows))
    }
  }
  for (const name of Object.keys(before.scenarios)) {
    if (!names.includes(name)) report.push(`${name}: scenario removed`)
  }

  const versions = [...new Set([...Object.keys(before.tied), macos])].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
  const otherVersions = versions.filter((version) => version !== macos)
  for (const version of versions) {
    const entry: Record<string, Counts> = {}
    for (const name of names) {
      const tied = version === macos ? measured.tied[macos][name] : before.tied[version][name]
      if (tied) entry[name] = tied
    }
    next.tied[version] = entry
  }

  if (!(macos in before.tied)) report.push(`macOS ${macos}: new entry for the tied fields`)
  for (const name of names) {
    const recorded = before.tied[macos]?.[name]
    if (recorded) {
      const rows = changes(recorded, measured.tied[macos][name])
      if (rows.length > 0) report.push(table(`${name}, tied fields on macOS ${macos}`, ['before', 'after'], rows))
    } else if (name in before.scenarios && macos in before.tied) {
      report.push(`${name}: tied fields added for macOS ${macos}`)
    }
  }
  const added = names.filter((name) => !(name in before.scenarios))
  if (added.length > 0 && otherVersions.length > 0) {
    report.push(`${added.join(', ')}: tied fields written for macOS ${macos} only; take macOS ${otherVersions.join(', ')}'s from the perf-gate-measured artifact of a CI run`)
  }
  for (const version of otherVersions) {
    const differing = names.filter((name) => {
      const recorded = before.tied[version][name]
      return recorded !== undefined && changes(recorded, measured.tied[macos][name]).length > 0
    })
    if (differing.length > 0) {
      report.push(`macOS ${version} kept as recorded; its tied fields differ from this run's for ${differing.join(', ')}. If the change moves them on ${version} too, retake its entry from the perf-gate-measured artifact`)
    }
  }
  return { next, report }
}
