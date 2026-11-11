/**
 * Keeps each renderer's native tree told which constructed sheets exist and which are adopted.
 *
 * Sheets are per native tree, so one renderer gets one copy of each sheet however many mutation
 * queues it has. A renderer that registers later is brought up to date when its queue registers.
 */

/** What the queue of a renderer offers: the two sheet ops of `MutationRenderer`. */
export interface SheetSink {
  setStyleSheet(sheetId: number, text: string | null): void
  setAdoptedStyleSheets(sheetIds: readonly number[]): void
  /**
   * A sheet native already holds changed. The queue calls `flushDirtySheets` with itself when it next
   * flushes, so a sheet changed n times in a tick is sent once, not n times.
   */
  sheetsDirty(): void
}

/** A sheet as the sync sees it. */
export interface SyncedSheet {
  /** Process-unique: the id native knows the sheet by. */
  readonly id: number
  readonly disabled: boolean
  /** The whole sheet text, which is what native parses on every change. */
  sheetText(): string
}

interface RendererSheets {
  readonly sinks: Set<WeakRef<SheetSink>>
  /** Ids of the sheets native holds the text of. */
  readonly known: Set<number>
  /** The adopted list native holds. */
  adopted: readonly number[]
  /** Sheets native holds whose text changed since the last flush of the queue that was told. */
  readonly dirty: Set<SyncedSheet>
  /** A change happened while no queue could carry it, so native may be behind: the next sync resends everything. */
  stale: boolean
}

const renderers = new Set<WeakRef<object>>()
const states = new WeakMap<object, RendererSheets>()
let adopted: readonly SyncedSheet[] = []
let nextSheetId = 1

export function allocateSheetId(): number {
  return nextSheetId++
}

function liveSink(state: RendererSheets): SheetSink | undefined {
  for (const ref of state.sinks) {
    const sink = ref.deref()
    if (sink) return sink
    state.sinks.delete(ref)
  }
  return undefined
}

/** The ids of the sheets that apply, each at the place of its last appearance: a repeated sheet counts once. */
function effectiveSheets(): SyncedSheet[] {
  const result: SyncedSheet[] = []
  for (let index = 0; index < adopted.length; index++) {
    const sheet = adopted[index]!
    if (sheet.disabled) continue
    if (adopted.indexOf(sheet, index + 1) !== -1) continue
    result.push(sheet)
  }
  return result
}

function sameIds(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index])
}

function syncRenderer(state: RendererSheets): void {
  const sink = liveSink(state)
  if (!sink) {
    state.stale = true
    return
  }
  const sheets = effectiveSheets()
  const wanted = new Set<number>()
  for (const sheet of sheets) {
    wanted.add(sheet.id)
    if (!state.stale && state.known.has(sheet.id)) continue
    sink.setStyleSheet(sheet.id, sheet.sheetText())
    state.dirty.delete(sheet)
    state.known.add(sheet.id)
  }
  const ids = sheets.map((sheet) => sheet.id)
  if (state.stale || !sameIds(state.adopted, ids)) {
    sink.setAdoptedStyleSheets(ids)
    state.adopted = ids
  }
  for (const id of [...state.known]) {
    if (wanted.has(id)) continue
    sink.setStyleSheet(id, null)
    state.known.delete(id)
  }
  state.stale = false
}

function eachRenderer(visit: (state: RendererSheets) => void): void {
  for (const ref of [...renderers]) {
    const renderer = ref.deref()
    const state = renderer === undefined ? undefined : states.get(renderer)
    if (state === undefined) renderers.delete(ref)
    else visit(state)
  }
}

/**
 * Called when a queue is created for `renderer`: from now on the sheet ops go through it, and a
 * renderer mounted after sheets were adopted gets them now.
 */
export function registerSheetSink(renderer: object, sink: SheetSink): void {
  let state = states.get(renderer)
  if (!state) {
    state = { sinks: new Set(), known: new Set(), dirty: new Set(), adopted: [], stale: false }
    states.set(renderer, state)
    renderers.add(new WeakRef(renderer))
  }
  state.sinks.add(new WeakRef(sink))
  syncRenderer(state)
}

/** `document.adoptedStyleSheets` changed. */
export function setAdoptedSheets(sheets: readonly SyncedSheet[]): void {
  adopted = [...sheets]
  eachRenderer(syncRenderer)
}

/**
 * The text or `disabled` state of `sheet` changed. Every renderer that holds it gets the new text
 * when its queue next flushes, once however many changes came before.
 */
export function sheetChanged(sheet: SyncedSheet): void {
  if (!adopted.includes(sheet)) return
  eachRenderer((state) => {
    const sink = liveSink(state)
    if (sink && !state.stale && state.known.has(sheet.id) && !sheet.disabled) {
      state.dirty.add(sheet)
      sink.sheetsDirty()
    } else {
      syncRenderer(state)
    }
  })
}

/** Called by a queue as it starts to flush, after it was told `sheetsDirty`: writes each changed sheet through `sink`. */
export function flushDirtySheets(renderer: object, sink: SheetSink): void {
  const state = states.get(renderer)
  if (!state) return
  for (const sheet of state.dirty) {
    if (state.known.has(sheet.id) && !sheet.disabled) sink.setStyleSheet(sheet.id, sheet.sheetText())
  }
  state.dirty.clear()
}
