import { fileURLToPath } from 'node:url'
import { createTestRoot } from '@ghia/solid/testing'
import { decodeWireBatchForTest, type TestRenderer } from '@ghia/native/testing'
import { App } from '../solid/mailbox-navigate/App'
import type { Message } from '../solid/mailbox-navigate/types'

const FRAME_MS = 1000 / 120
const MESSAGE_COUNT = 200
const STEPS = 20
const FONT_FILE = fileURLToPath(
  new URL('../../packages/react/src/__tests__/fixtures/inter-text-subset.ttf', import.meta.url),
)
const FONT_FAMILY = 'Inter'
const LIST_X = 430
const ROW_HEIGHT = 72
const FIRST_ROW_Y = 90
const VISIBLE_ROWS = 10

const FIRST_NAMES = ['Ada', 'Grace', 'Alan', 'Linus', 'Margaret', 'Dennis', 'Barbara', 'Ken']
const LAST_NAMES = ['Lovelace', 'Hopper', 'Turing', 'Torvalds', 'Hamilton', 'Ritchie', 'Liskov', 'Thompson']
const TOPICS = ['report', 'invoice', 'meeting', 'launch', 'budget', 'travel', 'review', 'roadmap']
const VERBS = ['Update', 'Question', 'Draft', 'Reminder', 'Summary', 'Follow up', 'Notes', 'Schedule']
const SENTENCES = [
  'Thanks for the quick turnaround on this.',
  'Could you take a look before Thursday?',
  'I attached the latest numbers for reference.',
  'Let me know if the timing works for everyone.',
  'We should decide who owns the next step.',
]

/** A fixed message list, so the counts depend on the engine and not on data. */
function makeMessages(): Message[] {
  let seed = 12345
  const next = (bound: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return Math.floor(seed / 65536) % bound
  }
  return Array.from({ length: MESSAGE_COUNT }, (_, id) => {
    const first = FIRST_NAMES[next(FIRST_NAMES.length)]
    const last = LAST_NAMES[next(LAST_NAMES.length)]
    const topic = TOPICS[next(TOPICS.length)]
    return {
      id,
      fromName: `${first} ${last}`,
      fromEmail: `${first}.${last}@example.com`.toLowerCase(),
      subject: `${VERBS[next(VERBS.length)]}: ${topic} ${id}`,
      snippet: `${SENTENCES[next(SENTENCES.length)]} ${SENTENCES[next(SENTENCES.length)]}`,
      body: [SENTENCES[next(SENTENCES.length)], SENTENCES[next(SENTENCES.length)], SENTENCES[next(SENTENCES.length)]],
      time: `${1 + next(12)}:${String(next(60)).padStart(2, '0')} PM`,
      dateLong: `November ${1 + next(28)}, 2026 at ${1 + next(12)}:00 PM`,
      unread: next(3) === 0,
      labels: [],
    }
  })
}

type BatchCounts = { calls: number; ops: number; bytes: number }

type Session = {
  renderer: TestRenderer
  batches: BatchCounts
  mount(): void
  frame(): void
  dispose(): void
}

function openWindow(): Session {
  const root = createTestRoot({ width: 1280, height: 800, scaleFactor: 1, appearance: 'light', fonts: [FONT_FILE] })
  const renderer = root.renderer
  const batches: BatchCounts = { calls: 0, ops: 0, bytes: 0 }
  const applyBatch = renderer.applyBatch
  // `readonly` is a type-level promise only; the root calls `renderer.applyBatch` on every flush, so this sees each batch.
  ;(renderer as { applyBatch: typeof applyBatch }).applyBatch = (bytes) => {
    batches.calls++
    batches.ops += decodeWireBatchForTest(bytes).length
    batches.bytes += bytes.length
    return applyBatch(bytes)
  }
  renderer.clockPause()
  renderer.setInlineDraws(false)
  const messages = makeMessages()
  const frame = () => {
    renderer.clockAdvance(FRAME_MS)
    renderer.dispatchNativeEvents()
    renderer.drawFrame()
  }
  return {
    renderer,
    batches,
    frame,
    mount() {
      root.render(() => (
        <div style={{ width: '100%', height: '100%', fontFamily: FONT_FAMILY }}>
          <App messages={messages} />
        </div>
      ))
    },
    dispose: () => root.unmount(),
  }
}

/** What the app does once it is up, until nothing paints: startup timers, the focus ring, scrollbar fades. */
function settle(session: Session) {
  session.mount()
  for (let i = 0; i < 5; i++) session.frame()
  session.renderer.clockAdvance(3000)
  session.renderer.dispatchNativeEvents()
  for (let i = 0; i < 5; i++) session.frame()
  const input = session.renderer.findByType('input')[0]
  if (!input) throw new Error('the mailbox has no search input')
  if (session.renderer.getFocusedElementId() !== input.id) {
    session.renderer.focusElement(input.id)
    session.frame()
    session.frame()
  }
  if (session.renderer.getFocusedElementId() !== input.id) throw new Error('the search input is not focused')
}

/** A frame after each input, the way the display link follows an event. */
function press(session: Session, keystrokes: string) {
  session.renderer.simulateKeystrokes(keystrokes)
  session.frame()
}

export type Scenario = {
  name: string
  /** Opens the session and warms it up; what it returns is the measured span. */
  prepare(session: Session): () => void
}

function listScrollTop(session: Session): number {
  const list = session.renderer.findByType('virtual-list')[0]
  if (!list) throw new Error('the mailbox has no virtual list')
  const metrics = session.renderer.getScrollMetrics(list.id)
  if (!metrics) throw new Error('the virtual list has no scroll metrics')
  return metrics[1]
}

export const scenarios: Scenario[] = [
  {
    name: 'mount',
    prepare: (session) => () => {
      session.mount()
      for (let i = 0; i < 3; i++) session.frame()
    },
  },
  {
    name: 'navigate',
    prepare(session) {
      settle(session)
      for (let i = 0; i < 2; i++) press(session, 'ArrowDown')
      return () => {
        for (let i = 0; i < STEPS; i++) press(session, 'ArrowDown')
      }
    },
  },
  {
    name: 'type',
    prepare(session) {
      settle(session)
      press(session, 'r')
      press(session, 'Backspace')
      return () => {
        for (const key of ['r', 'e', 'p', 'o', 'r', 't']) press(session, key)
      }
    },
  },
  {
    name: 'scroll',
    prepare(session) {
      settle(session)
      session.renderer.dispatchMouseMove(LIST_X, 442)
      session.frame()
      const wheel = () => {
        session.renderer.dispatchScrollWheel(LIST_X, 442, 0, 120, undefined, 'moved')
        session.frame()
      }
      for (let i = 0; i < 3; i++) wheel()
      return () => {
        const before = listScrollTop(session)
        for (let i = 0; i < STEPS; i++) wheel()
        if (listScrollTop(session) <= before) throw new Error('the list did not scroll')
      }
    },
  },
  {
    name: 'hover',
    prepare(session) {
      settle(session)
      session.renderer.dispatchMouseMove(LIST_X, FIRST_ROW_Y)
      for (let i = 0; i < 3; i++) session.frame()
      return () => {
        // Down the visible rows and back up, every move into a row of its own.
        let previous = 0
        for (let i = 1; i <= STEPS; i++) {
          const phase = i % (2 * (VISIBLE_ROWS - 1))
          const row = phase < VISIBLE_ROWS ? phase : 2 * (VISIBLE_ROWS - 1) - phase
          session.renderer.dispatchMouseMove(LIST_X, FIRST_ROW_Y + row * ROW_HEIGHT, undefined, {
            x: 0,
            y: (row - previous) * ROW_HEIGHT,
          })
          previous = row
          session.frame()
        }
      }
    },
  },
  {
    name: 'idle',
    prepare(session) {
      settle(session)
      return () => {
        for (let i = 0; i < STEPS; i++) session.frame()
      }
    },
  },
]

export type Counts = Record<string, number>

/** Every numeric field of the object, keyed `prefix.path`; the JSON and string fields are left out. */
function collectNumbers(prefix: string, value: unknown, into: Counts) {
  if (typeof value === 'number') into[prefix] = value
  else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.entries(value)) collectNumbers(`${prefix}.${entry[0]}`, entry[1], into)
  }
}

/** Fields that are not a count of work: ticks a session slept through depend on the wall clock of the host. */
const EXCLUDED = new Set(['frameWork.dormantTicks'])

function snapshot(session: Session): Counts {
  const renderer = session.renderer
  const counts: Counts = {}
  collectNumbers('build', renderer.getBuildCounters(), counts)
  collectNumbers('layout', renderer.getLayoutCounters(), counts)
  collectNumbers('frameWork', renderer.getFrameWorkCounters(), counts)
  collectNumbers('retained', renderer.getRetainedCounters(), counts)
  collectNumbers('patch', renderer.getPatchCounters(), counts)
  collectNumbers('applyBatch', session.batches, counts)
  counts.paintedFrames = renderer.getPaintedFrameCount()
  counts.layoutPasses = renderer.getLayoutPassCount()
  counts.culledSubtrees = renderer.getCulledSubtreeCount()
  for (const name of EXCLUDED) delete counts[name]
  return counts
}

/** The counts one scenario's measured span adds, from a session of its own. */
export function measure(scenario: Scenario): Counts {
  const session = openWindow()
  try {
    const run = scenario.prepare(session)
    session.renderer.resetBuildCounters()
    const before = snapshot(session)
    run()
    const after = snapshot(session)
    const delta: Counts = {}
    for (const name of Object.keys(after).sort()) delta[name] = after[name] - before[name]
    return delta
  } finally {
    session.dispose()
  }
}
