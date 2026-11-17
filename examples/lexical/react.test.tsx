import { writeFileSync } from 'node:fs'
import { Component, type ReactNode } from 'react'
import { afterAll, describe, expect, it } from 'vitest'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from 'lexical'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/react/testing'
import { settle } from '../base-ui/harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Json = Record<string, unknown>
const report: Json = {}
const note = (key: string, value: unknown): void => {
  report[key] = value
  console.log(`[lexical-react] ${key}: ${JSON.stringify(value, null, 1)}`)
}

const errorText = (error: unknown): Json => {
  if (!(error instanceof Error)) return { thrown: String(error) }
  return {
    name: error.name,
    message: error.message,
    stack: (error.stack ?? '').split('\n').slice(0, 14),
  }
}

// --------------------------------------------------------------------------------------------------------------
// Probes. Everything here observes; nothing patches behaviour (a wrapper calls straight through).
// --------------------------------------------------------------------------------------------------------------

const lexicalFrame = (stack: string | undefined): string | undefined =>
  (stack ?? '').split('\n').find((line) => /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(@?lexical)/.test(line))?.trim()

const registrations: Json[] = []
const invocations: Json[] = []
const observes: Json[] = []
const observerCallbacks: Json[] = []
const selectionCalls: Json[] = []
const missingReads = new Map<string, { count: number; firstLexicalFrame?: string }>()
const undefinedGetters = new Map<string, { count: number; firstLexicalFrame?: string }>()
const throwingMembers = new Map<string, { count: number; message: string; firstLexicalFrame?: string }>()
const usedMembers = new Map<string, number>()

function describeTarget(target: unknown): string {
  if (target === document) return 'document'
  if (target === globalThis || (typeof window !== 'undefined' && target === window)) return 'window'
  const element = target as Element
  if (element !== null && typeof element === 'object' && 'localName' in element) {
    const marks = ['data-lexical-editor', 'contenteditable', 'role'].filter((name) => element.hasAttribute?.(name))
    return `<${element.localName}${marks.map((name) => ` ${name}`).join('')}>`
  }
  return Object.prototype.toString.call(target)
}

function bump<T extends { count: number }>(map: Map<string, T>, key: string, make: () => T): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, make())
  else existing.count += 1
}

const patchedOwners = new Set<object>()
const wrappers = new WeakMap<object, EventListenerOrEventListenerObject>()
let installed = false
const restore: Array<() => void> = []

function ownerOf(start: object, key: string): object | undefined {
  for (let current: object | null = start; current !== null; current = Object.getPrototypeOf(current)) {
    if (Object.prototype.hasOwnProperty.call(current, key)) return current
  }
  return undefined
}

function patchEventTarget(start: object, label: string): void {
  const owner = ownerOf(start, 'addEventListener')
  if (owner === undefined || patchedOwners.has(owner)) return
  patchedOwners.add(owner)
  const add = (owner as EventTarget).addEventListener
  const remove = (owner as EventTarget).removeEventListener
  ;(owner as EventTarget).addEventListener = function (this: unknown, type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    if (listener === null || typeof listener !== 'object' && typeof listener !== 'function') return add.call(this, type, listener, options as never)
    const stack = new Error().stack
    const fromLexical = lexicalFrame(stack) !== undefined
    registrations.push({ target: describeTarget(this), owner: label, type, options: options ?? null, fromLexical, frame: lexicalFrame(stack) ?? null })
    const wrapper: EventListener = (event) => {
      const entry: Json = { target: describeTarget(this), type, eventType: event.type, fromLexical }
      invocations.push(entry)
      try {
        if (typeof listener === 'function') return listener.call(this, event)
        return listener.handleEvent(event)
      } catch (error) {
        entry.threw = errorText(error)
        throw error
      }
    }
    wrappers.set(listener, wrapper)
    return add.call(this, type, wrapper, options as never)
  } as never
  ;(owner as EventTarget).removeEventListener = function (this: unknown, type: string, listener: EventListenerOrEventListenerObject | null, options?: unknown) {
    const wrapper = listener === null ? listener : (wrappers.get(listener) ?? listener)
    return remove.call(this, type, wrapper, options as never)
  } as never
  restore.push(() => {
    ;(owner as EventTarget).addEventListener = add
    ;(owner as EventTarget).removeEventListener = remove
  })
}

/** Wraps every accessor and method on `proto` so reads that return undefined, and calls that throw, are recorded. */
function instrumentMembers(proto: object, label: string): void {
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === 'constructor' || key === 'addEventListener' || key === 'removeEventListener') continue
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (descriptor === undefined || !descriptor.configurable) continue
    const name = `${label}.${key}`
    if (descriptor.get !== undefined) {
      const getter = descriptor.get
      Object.defineProperty(proto, key, {
        ...descriptor,
        get(this: unknown) {
          let value: unknown
          try {
            value = getter.call(this)
          } catch (error) {
            const stack = new Error().stack
            bump(throwingMembers, name, () => ({ count: 1, message: String(error), firstLexicalFrame: lexicalFrame(stack) }))
            throw error
          }
          if (value === undefined) {
            const stack = new Error().stack
            const frame = lexicalFrame(stack)
            if (frame !== undefined) bump(undefinedGetters, name, () => ({ count: 1, firstLexicalFrame: frame }))
          }
          return value
        },
      })
    } else if (typeof descriptor.value === 'function') {
      const method = descriptor.value as (...args: unknown[]) => unknown
      Object.defineProperty(proto, key, {
        ...descriptor,
        value: function (this: unknown, ...args: unknown[]) {
          const stack = new Error().stack
          const frame = lexicalFrame(stack)
          if (frame !== undefined) usedMembers.set(name, (usedMembers.get(name) ?? 0) + 1)
          try {
            return method.apply(this, args)
          } catch (error) {
            bump(throwingMembers, name, () => ({ count: 1, message: String(error), firstLexicalFrame: frame }))
            throw error
          }
        },
      })
    }
  }
  restore.push(() => {
    // Members are left wrapped for the rest of the file; the wrappers pass straight through.
  })
}

/**
 * Members a DOM object does not have are not found on any prototype, so the lookup ends at the last prototype before
 * Object.prototype. A Proxy placed there as that prototype's prototype sees exactly those misses.
 */
function installMissingReadTrap(sample: object, label: string): void {
  let top: object = sample
  for (let next = Object.getPrototypeOf(top); next !== null && next !== Object.prototype; next = Object.getPrototypeOf(next)) top = next
  if (Object.getPrototypeOf(top) !== Object.prototype) return
  const trap = new Proxy(Object.prototype, {
    get(target, key, receiver) {
      if (typeof key === 'string' && !(key in target)) {
        const stack = new Error().stack
        const frame = lexicalFrame(stack)
        if (frame !== undefined) bump(missingReads, `${label}.${key}`, () => ({ count: 1, firstLexicalFrame: frame }))
      }
      return Reflect.get(target, key, receiver)
    },
    has(target, key) {
      return Reflect.has(target, key)
    },
  })
  Object.setPrototypeOf(top, trap)
}

function install(sample: HTMLElement): void {
  if (installed) return
  installed = true

  patchEventTarget(sample, 'element')
  patchEventTarget(document, 'document')
  patchEventTarget(globalThis, 'globalThis')
  if (typeof window !== 'undefined') patchEventTarget(window, 'window')

  for (const name of ['getSelection'] as const) {
    for (const host of [window, document] as Array<Record<string, unknown>>) {
      const original = host[name] as (() => Selection | null) | undefined
      if (typeof original !== 'function') {
        selectionCalls.push({ host: host === (document as unknown) ? 'document' : 'window', missing: true })
        continue
      }
      host[name] = function (this: unknown) {
        const stack = new Error().stack
        const result = original.call(this)
        selectionCalls.push({ host: host === (document as unknown) ? 'document' : 'window', returned: result === null ? 'null' : 'Selection', fromLexical: lexicalFrame(stack) !== undefined })
        return result
      }
    }
  }

  const MO = (globalThis as Json).MutationObserver as typeof MutationObserver | undefined
  if (MO !== undefined) {
    const observe = MO.prototype.observe
    MO.prototype.observe = function (this: MutationObserver, target: Node, options?: MutationObserverInit) {
      observes.push({ target: describeTarget(target), options: options ?? null, fromLexical: lexicalFrame(new Error().stack) !== undefined })
      return observe.call(this, target, options)
    }
    class ProbedMutationObserver extends MO {
      constructor(callback: MutationCallback) {
        super((records, observer) => {
          observerCallbacks.push({ records: records.length, types: records.map((record) => record.type) })
          return callback(records, observer)
        })
      }
    }
    ;(globalThis as Json).MutationObserver = ProbedMutationObserver
    if (typeof window !== 'undefined' && (window as unknown) !== globalThis) (window as unknown as Json).MutationObserver = ProbedMutationObserver
  }

  const text = document.createTextNode('x')
  const selection = document.getSelection?.()
  installMissingReadTrap(sample, 'Element')
  installMissingReadTrap(text, 'Text')
  installMissingReadTrap(document, 'Document')
  for (const proto of protoChain(sample)) instrumentMembers(proto, `Element(${proto.constructor.name})`)
  for (const proto of protoChain(text)) instrumentMembers(proto, `Text(${proto.constructor.name})`)
  for (const proto of protoChain(document)) instrumentMembers(proto, `Document(${proto.constructor.name})`)
  if (selection !== null && selection !== undefined) {
    installMissingReadTrap(selection, 'Selection')
    for (const proto of protoChain(selection)) instrumentMembers(proto, `Selection(${proto.constructor.name})`)
  }
}

function protoChain(object: object): object[] {
  const chain: object[] = []
  for (let current = Object.getPrototypeOf(object); current !== null && current !== Object.prototype; current = Object.getPrototypeOf(current)) chain.push(current)
  return chain
}

function resetProbes(): void {
  for (const list of [registrations, invocations, observes, observerCallbacks, selectionCalls]) list.length = 0
  for (const map of [missingReads, undefinedGetters, throwingMembers, usedMembers] as Array<Map<string, unknown>>) map.clear()
}

const sortedEntries = <V,>(map: Map<string, V>): Json =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))

function probeSnapshot(): Json {
  return {
    registrations: registrations.map((r) => ({ ...r })),
    mutationObserverObserve: [...observes],
    mutationObserverCallbacks: observerCallbacks.length,
    getSelectionCalls: selectionCalls.length,
    getSelectionSample: selectionCalls.slice(0, 5),
    missingReads: sortedEntries(missingReads),
    undefinedGetters: sortedEntries(undefinedGetters),
    throwingMembers: sortedEntries(throwingMembers),
    domMembersCalledByLexical: sortedEntries(new Map([...usedMembers.entries()].map(([k, v]) => [k, { count: v }]))),
  }
}

// --------------------------------------------------------------------------------------------------------------
// The app
// --------------------------------------------------------------------------------------------------------------

type Variant = { history: boolean; onChange: boolean; richText: boolean }
const FULL: Variant = { history: true, onChange: true, richText: true }

const changes: unknown[] = []
let editor: LexicalEditor | undefined

function CaptureEditor(): null {
  ;[editor] = useLexicalComposerContext()
  return null
}

function seed(): void {
  const root = $getRoot()
  const paragraph = $createParagraphNode()
  paragraph.append($createTextNode('Hello Lexical'))
  root.append(paragraph)
}

function SpikeApp(props: { variant: Variant }): ReactNode {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'spike',
        onError: (error: Error) => {
          throw error
        },
        editorState: seed,
      }}
    >
      <CaptureEditor />
      {props.variant.richText ? (
        <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
      ) : (
        <ContentEditable />
      )}
      {props.variant.history ? <HistoryPlugin /> : null}
      {props.variant.onChange ? (
        <OnChangePlugin
          onChange={(state) => {
            changes.push(state.toJSON())
          }}
        />
      ) : null}
    </LexicalComposer>
  )
}

class Catcher extends Component<{ children: ReactNode }, { error: unknown }> {
  state = { error: undefined as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  componentDidCatch(error: unknown) {
    caught.push(error)
  }
  render() {
    return this.state.error === undefined ? this.props.children : null
  }
}
const caught: unknown[] = []
const uncaught: unknown[] = []

type Session = { root: ReturnType<typeof createTestRoot>; renderer: ReturnType<typeof createTestRoot>['renderer'] }

function mountVariant(variant: Variant): { session: Session; syncError?: Json } {
  const root = createTestRoot({ width: 640, height: 480, onUncaughtError: (error: unknown) => uncaught.push(error) })
  const session: Session = { root, renderer: root.renderer }
  try {
    root.render(
      <Catcher>
        <SpikeApp variant={variant} />
      </Catcher>,
    )
  } catch (error) {
    return { session, syncError: errorText(error) }
  }
  return { session }
}

type HostNode = { tag?: string; text?: string; attrs?: Record<string, string>; children?: HostNode[] }

function walk(node: Node, depth = 0): HostNode {
  if (node.nodeType === 3) return { text: node.textContent ?? undefined }
  const element = node as HTMLElement
  const attrs: Record<string, string> = {}
  for (const name of element.getAttributeNames()) attrs[name] = element.getAttribute(name) ?? ''
  return { tag: element.localName, attrs, children: Array.from(element.childNodes).map((child) => walk(child, depth + 1)) }
}

function editableRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-lexical-editor], [contenteditable]')
}

function lexicalText(): string | { error: string } {
  if (editor === undefined) return { error: 'editor never captured' }
  return editor.getEditorState().read(() => $getRoot().getTextContent())
}

function paintedOrError(session: Session): unknown {
  try {
    return session.renderer.getPaintedText()
  } catch (error) {
    return errorText(error)
  }
}

let main: Session | undefined
const sessions: Session[] = []

afterAll(() => {
  for (const session of sessions) {
    try {
      session.root.unmount()
    } catch {
      // unmount after a failed mount is part of what the probes may break
    }
  }
  writeFileSync(new URL('./react-report.json', import.meta.url), JSON.stringify(report, null, 2))
})

describeNative('Lexical (React bindings) on Ghia', () => {
  it('1. mount: does it throw', async () => {
    // Install before the first render; a throwaway element supplies the prototype chain.
    install(document.createElement('div'))
    resetProbes()
    const result = mountVariant(FULL)
    main = result.session
    sessions.push(result.session)
    await settle(result.session).catch((error) => {
      uncaught.push(error)
    })
    note('1.mount', {
      syncError: result.syncError ?? null,
      errorBoundaryCaught: caught.map(errorText),
      uncaught: uncaught.map(errorText),
      editorCaptured: editor !== undefined,
      editorRootElement: editor?.getRootElement() ? describeTarget(editor.getRootElement()) : null,
      lexicalText: lexicalText(),
    })
  })

  it('1b. mount variants to localise a throw', async () => {
    const variants: Record<string, Variant> = {
      'no HistoryPlugin': { history: false, onChange: true, richText: true },
      'no OnChangePlugin': { history: true, onChange: false, richText: true },
      'no RichTextPlugin (bare ContentEditable)': { history: false, onChange: false, richText: false },
      'RichText only': { history: false, onChange: false, richText: true },
    }
    const results: Json = {}
    for (const [name, variant] of Object.entries(variants)) {
      caught.length = 0
      uncaught.length = 0
      const mounted = mountVariant(variant)
      try {
        await settle(mounted.session)
      } catch (error) {
        uncaught.push(error)
      }
      results[name] = {
        syncError: mounted.syncError ? (mounted.syncError.message as string) : null,
        caught: caught.map((e) => String((e as Error).message)),
        uncaught: uncaught.map((e) => String((e as Error).message)),
        painted: paintedOrError(mounted.session),
        hasEditableRoot: editableRoot() !== null,
      }
      try {
        mounted.session.root.unmount()
      } catch (error) {
        ;(results[name] as Json).unmountError = String(error)
      }
    }
    note('1b.variants', results)
    // restore the full-variant editor handle for the later probes
    caught.length = 0
    uncaught.length = 0
  })

  it('2. painted text and the tree Lexical built', async () => {
    if (main === undefined) throw new Error('no session')
    // The variants unmounted their own roots; the editor handle belongs to the last one, so recapture from main.
    const rootElement = editableRoot()
    note('2.tree', {
      painted: paintedOrError(main),
      editableRootFound: rootElement !== null,
      tree: rootElement === null ? null : walk(rootElement),
      documentBody: walk(document.body),
      isContentEditable: rootElement?.isContentEditable ?? null,
      contentEditableProp: rootElement?.contentEditable ?? null,
    })
  })

  it('3. DOM probes: listeners, selection, observers, undefined/throwing members', async () => {
    note('3.probes', probeSnapshot())
    const view = editor?.getRootElement()?.ownerDocument?.defaultView
    note('3.ownerDocumentDefaultView', {
      ownerDocumentIsDocument: editor?.getRootElement()?.ownerDocument === document,
      defaultViewIsWindow: view === (typeof window === 'undefined' ? undefined : window),
      defaultViewIsGlobalThis: view === globalThis,
      defaultViewType: typeof view,
    })
  })
})

// The steps below run on a fresh mount of the full app so the earlier variants cannot interfere.
describeNative('Lexical input and updates', () => {
  let session: Session

  const eventLog = (from: number): Json[] => invocations.slice(from)

  const snapshot = (): Json => ({ lexicalText: lexicalText(), painted: paintedOrError(session), activeElement: describeTarget(document.activeElement) })

  const step = async (label: string, action: () => void | Promise<void>): Promise<void> => {
    const from = invocations.length
    const before = snapshot()
    let error: unknown
    try {
      await action()
      await settle(session)
    } catch (caughtError) {
      error = caughtError
    }
    const reached = eventLog(from)
    const tally: Record<string, number> = {}
    for (const entry of reached) tally[`${entry.target}:${entry.eventType}`] = (tally[`${entry.target}:${entry.eventType}`] ?? 0) + 1
    note(label, { error: error === undefined ? null : errorText(error), before, after: snapshot(), eventsReachedLexical: tally, listenerThrows: reached.filter((e) => e.threw).map((e) => e.threw) })
  }

  it('prepare: fresh mount', async () => {
    caught.length = 0
    uncaught.length = 0
    changes.length = 0
    resetProbes()
    const mounted = mountVariant(FULL)
    session = mounted.session
    sessions.push(session)
    await settle(session)
    note('prepare', { syncError: mounted.syncError ?? null, hasEditableRoot: editableRoot() !== null, registrationsAfterMount: registrations.length, changesAfterMount: changes.length })
  })

  it('4a. focus the editable', async () => {
    const root = editableRoot()
    if (root === null) throw new Error('no editable root element')
    await step('4a.focus', () => root.focus())
    note('4a.focusOutcome', { rootIsActive: document.activeElement === root, tabIndex: root.tabIndex })
  })

  it('4b. type "abc"', async () => {
    await step('4b.type-abc', () => {
      for (const key of ['a', 'b', 'c']) session.renderer.simulateKeystrokes(key)
    })
  })

  it('4c. Enter then Backspace', async () => {
    await step('4c.enter', () => session.renderer.simulateKeystrokes('Enter'))
    await step('4c.backspace', () => session.renderer.simulateKeystrokes('Backspace'))
  })

  it('4d. composition commit', async () => {
    const root = editableRoot()
    if (root === null) throw new Error('no editable root element')
    const id = (root as unknown as { native?: { id: number } }).native?.id
    await step('4d.composition', () => {
      if (id === undefined) throw new Error('root element has no native id')
      session.renderer.simulateComposition(id, [
        { key: 'n', action: 'mark', text: 'に' },
        { key: 'Enter', action: 'commit', text: '日' },
      ])
    })
  })

  it('4e. direct selectionchange-driving: select text and read the Selection', async () => {
    const root = editableRoot()
    if (root === null) throw new Error('no editable root element')
    const selection = document.getSelection()
    let outcome: Json
    try {
      const textNode = root.querySelector('span')?.firstChild
      if (textNode === null || textNode === undefined) throw new Error('no text node under the editable')
      selection?.setBaseAndExtent(textNode, 1, textNode, 3)
      outcome = { type: selection?.type, anchorOffset: selection?.anchorOffset, focusOffset: selection?.focusOffset, text: selection?.toString() }
    } catch (error) {
      outcome = errorText(error) as Json
    }
    await step('4e.selection-set', () => undefined)
    note('4e.selectionOutcome', outcome)
  })

  it('5. editor.update replaces the content', async () => {
    if (editor === undefined) throw new Error('no editor')
    const changesBefore = changes.length
    let updateError: unknown
    try {
      editor.update(() => {
        const root = $getRoot()
        root.clear()
        const paragraph = $createParagraphNode()
        paragraph.append($createTextNode('Updated'))
        root.append(paragraph)
      })
    } catch (error) {
      updateError = error
    }
    await settle(session)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await settle(session)
    const rootElement = editableRoot()
    note('5.update', {
      updateError: updateError === undefined ? null : errorText(updateError),
      uncaught: uncaught.map(errorText),
      lexicalText: lexicalText(),
      painted: paintedOrError(session),
      paintedShowsUpdated: JSON.stringify(paintedOrError(session)).includes('Updated'),
      onChangeFired: changes.length > changesBefore,
      changesTotal: changes.length,
      domTextOfRoot: rootElement?.textContent ?? null,
    })
  })

  it('final probes after interaction', () => {
    note('final.probes', probeSnapshot())
    note('final.invocationTotals', invocations.reduce<Record<string, number>>((acc, entry) => {
      const key = `${entry.target}:${entry.eventType}`
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}))
    expect(true).toBe(true)
  })
})
