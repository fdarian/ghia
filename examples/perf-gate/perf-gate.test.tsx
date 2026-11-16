import { readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, it } from 'vitest'
import { hasNativeTestRenderer } from '@ghia/native/testing'
import { measure, scenarios, type Counts } from './scenarios'

/** Ceilings are counts of work, never times: a count above its ceiling fails, `PERF_GATE_UPDATE=1` rewrites them. */
const CEILINGS_PATH = new URL('./ceilings.json', import.meta.url)
const UPDATE = process.env.PERF_GATE_UPDATE === '1'

const ceilings: Record<string, Counts> = UPDATE ? {} : JSON.parse(readFileSync(CEILINGS_PATH, 'utf8'))
const measured: Record<string, Counts> = {}
const canTighten: string[] = []

function violations(scenario: string, counts: Counts): string[] {
  const ceiling = ceilings[scenario]
  if (!ceiling) return [`${scenario}: no ceilings in ceilings.json (PERF_GATE_UPDATE=1 baselines it)`]
  const failures: string[] = []
  for (const field of Object.keys(counts)) {
    const value = counts[field]
    if (!(field in ceiling)) failures.push(`${scenario}: ${field} = ${value} has no ceiling (new counter: PERF_GATE_UPDATE=1)`)
    else if (value > ceiling[field]) failures.push(`${scenario}: ${field} = ${value} is above its ceiling ${ceiling[field]}`)
    else if (value < ceiling[field]) canTighten.push(`${scenario}: ${field} = ${value}, ceiling ${ceiling[field]}`)
  }
  for (const field of Object.keys(ceiling)) {
    if (!(field in counts)) failures.push(`${scenario}: ${field} has a ceiling but is no longer measured`)
  }
  return failures
}

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('perf gate', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const counts = measure(scenario)
      measured[scenario.name] = counts
      if (UPDATE) return
      const failures = violations(scenario.name, counts)
      if (failures.length > 0) throw new Error(`perf gate failed:\n  ${failures.join('\n  ')}`)
    })
  }

  afterAll(() => {
    if (UPDATE) {
      writeFileSync(CEILINGS_PATH, `${JSON.stringify(measured, null, 2)}\n`)
      console.log(`perf gate: ceilings.json rewritten to the measured counts of ${Object.keys(measured).join(', ')}`)
      return
    }
    if (canTighten.length > 0) console.log(`perf gate: ${canTighten.length} ceilings can tighten\n  ${canTighten.join('\n  ')}`)
  })
})
