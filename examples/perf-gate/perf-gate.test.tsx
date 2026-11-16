import { changes, table } from './counts-file'
import { defineGate } from './gate'
import { measure, scenarios, type Counts, type Scenario } from './scenarios'

function measureTwice(scenario: Scenario): Counts {
  // A window's first build in the process counts differently (mount computed 2 style applies more, which a later window
  // replays: a process-wide cache is cold), so the counts would depend on which scenario ran before it. A run nobody reads
  // warms that up; cold-mount.test.tsx measures the cold one.
  measure(scenario)
  const first = measure(scenario)
  const second = measure(scenario)
  const unstable = changes(first, second)
  if (unstable.length > 0) {
    throw new Error(`perf gate: ${scenario.name} measured different counts in two fresh windows\n${table(scenario.name, ['first', 'second'], unstable)}`)
  }
  return first
}

defineGate('perf-gate', scenarios, measureTwice)
