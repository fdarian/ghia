import { fileURLToPath } from 'node:url'
import { createTestRoot } from '@ghia/solid/testing'
import { decodeWireBatchForTest, type TestRenderer } from '@ghia/native/testing'
import { App, type Message } from './app'

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
/** The warm-up of every scenario that moves the selection presses ArrowDown this often before the span. */
const WARMUP_PRESSES = 2
const VISIBLE_ROWS = 10
const IDLE_MS = 1500

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

type Styling = 'inline' | 'sheet'

type Session = {
  renderer: TestRenderer
  messages: Message[]
  batches: BatchCounts
  mount(): void
  frame(): void
  dispose(): void
}

function openWindow(styling: Styling): Session {
  const root = createTestRoot({ width: 1280, height: 800, scaleFactor: 1, appearance: 'light', fonts: [FONT_FILE] })
  const renderer = root.renderer
  // The accessibility tree holds every list scroll off the scroll-patch fast path, as it does in the profilers.
  renderer.setA11yActive(false)
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
    messages,
    batches,
    frame,
    mount() {
      root.render(() => (
        <div style={{ width: '100%', height: '100%', fontFamily: FONT_FAMILY }}>
          <App messages={messages} styling={styling} />
        </div>
      ))
    },
    dispose: () => root.unmount(),
  }
}

/** What the app does once it is up, until nothing paints: the focus ring, scrollbar fades, the first caret blink. */
function settle(session: Session) {
  session.mount()
  for (let i = 0; i < 5; i++) session.frame()
  // The motion clock is paused and `clockAdvance` moves only that one; `advanceTime` moves GPUI's own, which is what fires
  // the timers an app starts at mount.
  session.renderer.clockAdvance(3000)
  session.renderer.advanceTime(3000)
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
  styling: Styling
  /** Opens the session and warms it up. `run` is the measured span; `verify` runs after it, outside the span, and throws if the app did not do what the scenario is for. */
  prepare(session: Session): { run(): void; verify(): void }
}

function listOf(session: Session) {
  const list = session.renderer.findByType('virtual-list')[0]
  if (!list) throw new Error('the mailbox has no virtual list')
  return list
}

function listScrollTop(session: Session): number {
  const metrics = session.renderer.getScrollMetrics(listOf(session).id)
  if (!metrics) throw new Error('the virtual list has no scroll metrics')
  return metrics[1]
}

/** How many elements show exactly this text. */
function textCount(session: Session, text: string): number {
  return session.renderer.getAllText().filter((candidate) => candidate === text).length
}

function expectTextCount(session: Session, text: string, count: number, what: string) {
  const actual = textCount(session, text)
  if (actual !== count) throw new Error(`${what}: "${text}" is shown ${actual} times, expected ${count}`)
}

/** The list row under the window point: the ancestor of the topmost element there that is a child of the virtual list. */
function rowBackground(session: Session, y: number): string {
  const renderer = session.renderer
  const listId = listOf(session).id
  for (const id of renderer.getElementsAt(LIST_X, y)) {
    let element = renderer.getElement(id)
    while (element && element.parentId !== listId) element = element.parentId === null ? undefined : renderer.getElement(element.parentId)
    if (!element) continue
    const style = renderer.getComputedStyle(element.id, false)
    if (!style) throw new Error('the row has no computed style')
    for (let i = 0; i < style.length; i += 2) {
      if (style[i] === 'background-color') return style[i + 1]
    }
    throw new Error('the row has no computed background-color')
  }
  throw new Error(`no list row at y = ${y}`)
}

/** The row the pointer enters in step `step`: down the visible rows and back up, every move into a row of its own. */
function hoverRow(step: number): number {
  const phase = step % (2 * (VISIBLE_ROWS - 1))
  return phase < VISIBLE_ROWS ? phase : 2 * (VISIBLE_ROWS - 1) - phase
}

function navigate(name: string, styling: Styling): Scenario {
  return {
    name,
    styling,
    prepare(session) {
      settle(session)
      for (let i = 0; i < WARMUP_PRESSES; i++) press(session, 'ArrowDown')
      const subject = (index: number) => session.messages[index].subject
      // The subject is in the detail pane and in its row.
      expectTextCount(session, subject(WARMUP_PRESSES), 2, 'before navigating')
      return {
        run() {
          for (let i = 0; i < STEPS; i++) press(session, 'ArrowDown')
        },
        verify() {
          expectTextCount(session, subject(WARMUP_PRESSES + STEPS), 2, 'after navigating')
          expectTextCount(session, subject(WARMUP_PRESSES), 1, 'after navigating')
        },
      }
    },
  }
}

const mount: Scenario = {
  name: 'mount',
  styling: 'inline',
  prepare: (session) => ({
    run() {
      session.mount()
      for (let i = 0; i < 3; i++) session.frame()
    },
    verify() {
      expectTextCount(session, `${MESSAGE_COUNT} conversations`, 1, 'after mounting')
      expectTextCount(session, session.messages[1].subject, 1, 'after mounting')
    },
  }),
}

/** `mount` as the first window of a process, which `cold-mount.test.tsx` measures once with no warm-up. */
export const coldMount: Scenario = { ...mount, name: 'cold-mount' }

export const scenarios: Scenario[] = [
  mount,
  {
    name: 'mount-css',
    styling: 'sheet',
    prepare: (session) => ({
      run() {
        session.mount()
        for (let i = 0; i < 3; i++) session.frame()
      },
      verify() {
        expectTextCount(session, `${MESSAGE_COUNT} conversations`, 1, 'after mounting')
        expectTextCount(session, session.messages[1].subject, 1, 'after mounting')
      },
    }),
  },
  navigate('navigate', 'inline'),
  navigate('navigate-css', 'sheet'),
  {
    name: 'type',
    styling: 'inline',
    prepare(session) {
      settle(session)
      press(session, 'r')
      press(session, 'Backspace')
      const query = 'report'
      const matches = session.messages.filter((message) =>
        `${message.fromName} ${message.subject} ${message.snippet}`.toLowerCase().includes(query),
      ).length
      if (matches === 0 || matches === MESSAGE_COUNT) throw new Error(`"${query}" matches ${matches} of ${MESSAGE_COUNT} messages, so typing it proves nothing`)
      expectTextCount(session, `${MESSAGE_COUNT} conversations`, 1, 'before typing')
      return {
        run() {
          for (const key of query) press(session, key)
        },
        verify() {
          expectTextCount(session, `${matches} conversations`, 1, 'after typing')
          expectTextCount(session, `${MESSAGE_COUNT} conversations`, 0, 'after typing')
        },
      }
    },
  },
  {
    name: 'scroll',
    styling: 'inline',
    prepare(session) {
      settle(session)
      session.renderer.dispatchMouseMove(LIST_X, 442)
      session.frame()
      const wheel = () => {
        session.renderer.dispatchScrollWheel(LIST_X, 442, 0, 120, undefined, 'moved')
        session.frame()
      }
      for (let i = 0; i < 3; i++) wheel()
      // Reading the scroll offset can flush and lay out, so the reads sit outside the span and a frame follows them.
      const top = listScrollTop(session)
      // Message 1 is a row of the first window and nowhere else; it is unmounted once the window start moves.
      const probe = session.messages[1].subject
      expectTextCount(session, probe, 1, 'before scrolling')
      session.frame()
      return {
        run() {
          for (let i = 0; i < STEPS; i++) wheel()
        },
        verify() {
          if (listScrollTop(session) <= top) throw new Error('the list did not scroll')
          expectTextCount(session, probe, 0, 'after scrolling, the window start did not move')
        },
      }
    },
  },
  {
    name: 'hover',
    styling: 'inline',
    prepare(session) {
      settle(session)
      session.renderer.dispatchMouseMove(LIST_X, FIRST_ROW_Y)
      for (let i = 0; i < 3; i++) session.frame()
      const lastY = FIRST_ROW_Y + hoverRow(STEPS) * ROW_HEIGHT
      const before = rowBackground(session, lastY)
      session.frame()
      return {
        run() {
          let previous = 0
          for (let i = 1; i <= STEPS; i++) {
            const row = hoverRow(i)
            session.renderer.dispatchMouseMove(LIST_X, FIRST_ROW_Y + row * ROW_HEIGHT, undefined, {
              x: 0,
              y: (row - previous) * ROW_HEIGHT,
            })
            previous = row
            session.frame()
          }
        },
        verify() {
          const after = rowBackground(session, lastY)
          if (after === before) throw new Error(`the hovered row's background did not change from ${before}`)
        },
      }
    },
  },
  {
    name: 'idle',
    styling: 'inline',
    prepare(session) {
      settle(session)
      return {
        // GPUI's clock advances too, so the focused input's caret blinks inside the span.
        run() {
          for (let i = 0; i < STEPS; i++) {
            session.renderer.advanceTime(IDLE_MS / STEPS)
            session.frame()
          }
        },
        verify() {
          const input = session.renderer.findByType('input')[0]
          if (!input || session.renderer.getFocusedElementId() !== input.id) throw new Error('the search input lost focus while idle')
        },
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

/** Fields that are not a count the engine controls: ticks a session slept through depend on the wall clock of the host, and
 *  rasterized glyphs on the user's AppleFontSmoothing setting, which is in the glyph atlas key. */
const EXCLUDED = new Set(['frameWork.dormantTicks', 'frameWork.rasterizedGlyphs'])

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

function difference(before: Counts, after: Counts): Counts {
  const delta: Counts = {}
  for (const name of Object.keys(after).sort()) {
    if (!(name in before)) throw new Error(`${name} is measured after the span but was not read before it`)
    const change = after[name] - before[name]
    if (!Number.isFinite(change)) throw new Error(`${name} went from ${before[name]} to ${after[name]}`)
    delta[name] = change
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) throw new Error(`${name} was read before the span but not after it`)
  }
  return delta
}

/** The counts one scenario's measured span adds, from a session of its own. */
export function measure(scenario: Scenario): Counts {
  const session = openWindow(scenario.styling)
  try {
    const step = scenario.prepare(session)
    session.renderer.resetBuildCounters()
    const before = snapshot(session)
    step.run()
    const after = snapshot(session)
    step.verify()
    return difference(before, after)
  } finally {
    session.dispose()
  }
}
