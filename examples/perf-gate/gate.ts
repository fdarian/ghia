import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { afterAll, describe, it } from 'vitest'
import { hasNativeTestRenderer } from '@ghia/native/testing'
import { compareToExpected, readExpected } from './counts-file'
import { writePart } from './measured'
import type { Counts, Scenario } from './scenarios'

const UPDATE = process.env.PERF_GATE_UPDATE === '1'

function addToSummary(title: string, text: string) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) appendFileSync(summaryPath, `### Perf gate: ${title}\n\n\`\`\`\n${text}\n\`\`\`\n`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function refuseUnlessReproducible() {
  if (!hasNativeTestRenderer) throw new Error('perf gate: the native addon was built without test-support')
  const gpuix = Object.keys(process.env).filter((name) => name.startsWith('GPUIX_'))
  if (gpuix.length > 0) throw new Error(`perf gate: ${gpuix.join(', ')} change what the engine does; unset them`)
  if (process.env.SEED !== undefined) throw new Error('perf gate: SEED is set; unset it')
  if (process.env.NODE_ENV !== 'production') throw new Error('perf gate: run it as `bun run test:perf-gate`, which sets NODE_ENV=production')
}

/** One test file of the gate: measures each scenario with `measureScenario`, compares it with expected-counts.json, and leaves what it measured for the global setup's teardown. */
export function defineGate(part: string, scenarios: Scenario[], measureScenario: (scenario: Scenario) => Counts) {
  try {
    refuseUnlessReproducible()
  } catch (error) {
    addToSummary(`${part} did not start`, messageOf(error))
    throw error
  }
  const macos = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
  const expected = readExpected()
  const counts: Record<string, Counts> = {}
  const failed = new Set<string>()
  const sameAs = new Set<string>()

  describe(part, () => {
    for (const scenario of scenarios) {
      it(scenario.name, () => {
        try {
          counts[scenario.name] = measureScenario(scenario)
          if (UPDATE) return
          if (!expected) throw new Error('perf gate: expected-counts.json does not exist (PERF_GATE_UPDATE=1 writes it)')
          const same = compareToExpected(expected, macos, scenario.name, counts[scenario.name])
          if (same) sameAs.add(same)
        } catch (error) {
          failed.add(scenario.name)
          addToSummary(scenario.name, messageOf(error))
          throw error
        }
      })
    }

    afterAll(() => {
      writePart(part, { macos, names: scenarios.map((scenario) => scenario.name), counts, failed: [...failed], sameAs: [...sameAs] })
    })
  })
}
