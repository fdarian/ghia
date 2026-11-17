// Spike, not a regression test: every `it` is a probe that records what vanilla Lexical does inside a
// @ghia/solid component into `solid-report.json`. Nothing here is fixed in Ghia.
import { onMount } from 'solid-js'
import { writeFileSync } from 'node:fs'
import { afterAll, describe, it } from 'vitest'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { hasNativeTestRenderer } from '@ghia/solid/testing'
import { focus, mount, press, query, settle } from '../solid-harness'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Variant = 'bare' | 'richText' | 'history' | 'full'

const report: Record<string, unknown> = {}

function errorInfo(error: unknown) {
  if (!(error instanceof Error)) return { message: String(error) }
  const frames = (error.stack ?? '').split('\n').slice(1).map((line) => line.trim())
  return { name: error.name, message: error.message, frames: frames.slice(0, 14) }
}

type ListenerRecord = { target: string; type: string; options: unknown }
type Probe = {
  listeners: ListenerRecord[]
  invoked: { target: string; type: string; defaultPrevented: boolean }[]
  getSelectionCalls: string[]
  mutationObserve: string[]
  undefinedReads: Record<string, number>
  throwingReads: Record<string, string>
  rootEl: unknown
  errors: { phase: string; error: ReturnType<typeof errorInfo> }[]
  updates: unknown[]
  restore(): void
}

// Installed before the editor exists and removed after the test: every Lexical-facing DOM entry point logs.
function instrument(): Probe {
  const probe: Probe = {
    listeners: [],
    invoked: [],
    getSelectionCalls: [],
    mutationObserve: [],
    undefinedReads: {},
    throwingReads: {},
    rootEl: undefined,
    errors: [],
    updates: [],
    restore: () => {},
  }
  const restores: (() => void)[] = []
  const g = globalThis as any
  const label = (target: unknown): string => {
    if (target === g) return 'window'
    if (target === g.document) return 'document'
    if (target === probe.rootEl) return 'root'
    const node = target as { nodeName?: string }
    return node?.nodeName ?? String(target)
  }
  const wrappers = new WeakMap<object, (event: Event) => unknown>()
  const wrapListener = (target: unknown, type: string, listener: any) => {
    if (typeof listener !== 'function') return listener
    const existing = wrappers.get(listener)
    if (existing) return existing
    const wrapped = function (this: unknown, event: Event) {
      const result = listener.call(this, event)
      probe.invoked.push({ target: label(target), type, defaultPrevented: event.defaultPrevented })
      return result
    }
    wrappers.set(listener, wrapped)
    return wrapped
  }
  const ownerOf = (object: any, name: string) => {
    for (let p = object; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, name)) return p
    return undefined
  }
  const patch = (object: any, name: string, make: (original: any) => any) => {
    const owner = ownerOf(object, name)
    if (!owner) throw new Error(`no ${name} on chain`)
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)!
    const original = descriptor.value
    Object.defineProperty(owner, name, { ...descriptor, value: make(original) })
    restores.push(() => Object.defineProperty(owner, name, descriptor))
  }
  const wrapAdd = (original: any) =>
    function (this: unknown, type: string, listener: any, options: unknown) {
      probe.listeners.push({ target: label(this), type, options })
      return original.call(this, type, wrapListener(this, type, listener), options)
    }
  const wrapRemove = (original: any) =>
    function (this: unknown, type: string, listener: any, options: unknown) {
      const wrapped = listener && typeof listener === 'function' ? (wrappers.get(listener) ?? listener) : listener
      return original.call(this, type, wrapped, options)
    }
  // `window` is globalThis; `document` and every Element share the prototype that owns addEventListener.
  patch(g, 'addEventListener', wrapAdd)
  patch(g, 'removeEventListener', wrapRemove)
  patch(g.document, 'addEventListener', wrapAdd)
  patch(g.document, 'removeEventListener', wrapRemove)
  // The element prototype is only reachable once an element exists, which needs a mounted root.
  ;(probe as any).patchElements = (element: HTMLElement) => {
    const elementOwner = ownerOf(element, 'addEventListener')
    const documentOwner = ownerOf(g.document, 'addEventListener')
    report.addEventListenerOwners = {
      element: elementOwner?.constructor?.name,
      elementIsDocumentOwner: elementOwner === documentOwner,
    }
    if (elementOwner !== documentOwner) {
      patch(element, 'addEventListener', wrapAdd)
      patch(element, 'removeEventListener', wrapRemove)
    }
  }

  if (typeof g.MutationObserver === 'function') {
    patch(g.MutationObserver.prototype, 'observe', (original: any) =>
      function (this: unknown, target: unknown, options: unknown) {
        probe.mutationObserve.push(`${label(target)} ${JSON.stringify(options)}`)
        return original.call(this, target, options)
      })
  } else probe.mutationObserve.push('MutationObserver is not a function')

  const record = (path: string, value: unknown) => {
    if (value === undefined) probe.undefinedReads[path] = (probe.undefinedReads[path] ?? 0) + 1
  }
  // Methods are bound to the real object: Ghia's members look their state up by `this`.
  const watch = <T extends object>(target: T, name: string, wrapReturn?: Record<string, (value: any) => any>): T =>
    new Proxy(target, {
      get(object, key) {
        const path = `${name}.${String(key)}`
        let value: unknown
        try {
          value = Reflect.get(object, key, object)
        } catch (error) {
          probe.throwingReads[path] = String(error)
          throw error
        }
        if (typeof key === 'symbol') return value
        record(path, value)
        if (typeof value === 'function') {
          return (...args: unknown[]) => {
            try {
              const result = (value as Function).apply(object, args)
              if (result === undefined && wrapReturn === undefined) return result
              const wrapper = wrapReturn?.[key]
              return wrapper ? wrapper(result) : result
            } catch (error) {
              probe.throwingReads[`${path}()`] = String(error)
              throw error
            }
          }
        }
        const wrapper = wrapReturn?.[key]
        return wrapper && value ? wrapper(value) : value
      },
      set(object, key, value) {
        return Reflect.set(object, key, value, object)
      },
    })

  const watchedSelection = (selection: object) => watch(selection, 'selection')
  for (const [owner, name] of [[g, 'window'], [g.document, 'document']] as const) {
    patch(owner, 'getSelection', (original: any) =>
      function (this: unknown) {
        probe.getSelectionCalls.push(name)
        const result = original.call(this)
        return result ? watchedSelection(result) : result
      })
  }
  probe.restore = () => restores.reverse().forEach((restore) => restore())
  ;(probe as any).watchRoot = (element: HTMLElement): HTMLElement => {
    const windowProxy = watch(g, 'window', { getSelection: watchedSelection })
    return watch(element, 'root', {
      ownerDocument: () => watch(g.document, 'ownerDocument', { defaultView: () => windowProxy, getSelection: watchedSelection }),
    })
  }
  return probe
}

const ATTRIBUTES = [
  'contenteditable', 'data-lexical-editor', 'data-lexical-text', 'role', 'spellcheck', 'style', 'class', 'dir',
  'data-lexical-decorator', 'data-lexical-lineBreak', 'tabindex', 'autocorrect', 'autocapitalize', 'aria-readonly',
]

function dumpTree(node: any): unknown {
  const entry: Record<string, unknown> = { nodeName: node.nodeName, nodeType: node.nodeType }
  if (node.nodeType === 3) entry.text = node.textContent
  if (node.nodeType === 1) {
    entry.attributesProperty = typeof node.attributes
    entry.getAttributeNames = typeof node.getAttributeNames === 'function' ? node.getAttributeNames() : 'missing'
    const present: Record<string, string | null> = {}
    for (const name of ATTRIBUTES) {
      const value = node.getAttribute(name)
      if (value !== null) present[name] = value
    }
    entry.knownAttributes = present
    entry.className = typeof node.className === 'string' ? node.className : typeof node.className
    entry.styleCssText = node.style?.cssText ?? typeof node.style
    entry.contentEditable = typeof node.contentEditable === 'string' ? node.contentEditable : typeof node.contentEditable
    entry.isContentEditable = node.isContentEditable
    entry.tabIndex = node.tabIndex
    entry.dataset = node.dataset ? { ...node.dataset } : typeof node.dataset
    entry.outerHTML = typeof node.outerHTML === 'string' ? node.outerHTML : typeof node.outerHTML
  }
  entry.children = Array.from(node.childNodes as ArrayLike<unknown>).map((child) => dumpTree(child))
  return entry
}

type Launched = {
  app: ReturnType<typeof mount>
  el: HTMLElement
  editor: LexicalEditor | undefined
  probe: Probe
}

function launch(variant: Variant, options: { seed?: boolean; proxyRoot?: boolean; tabIndex?: number } = {}): Launched {
  const probe = instrument()
  const launched: Launched = { app: undefined as never, el: undefined as never, editor: undefined, probe }
  const phase = (name: string, fn: () => void) => {
    try {
      fn()
    } catch (error) {
      probe.errors.push({ phase: name, error: errorInfo(error) })
    }
  }
  function Editor() {
    let el!: HTMLDivElement
    onMount(() => {
      launched.el = el
      probe.rootEl = el
      phase('patchElements', () => (probe as any).patchElements(el))
      phase('createEditor', () => {
        launched.editor = createEditor({
          namespace: 'spike',
          onError: (error) => {
            probe.errors.push({ phase: 'onError', error: errorInfo(error) })
            throw error
          },
        })
      })
      const editor = launched.editor
      if (editor === undefined) return
      if (variant === 'richText' || variant === 'full') phase('registerRichText', () => registerRichText(editor))
      if (variant === 'history' || variant === 'full') {
        phase('registerHistory', () => registerHistory(editor, createEmptyHistoryState(), 300))
      }
      editor.registerUpdateListener(({ editorState }) => {
        probe.updates.push(editorState.toJSON())
      })
      let root: HTMLElement = el
      if (options.proxyRoot) root = (probe as any).watchRoot(el)
      phase('setRootElement', () => editor.setRootElement(root))
      if (options.seed !== false) {
        phase('seed update', () => {
          editor.update(() => {
            const paragraph = $createParagraphNode()
            paragraph.append($createTextNode('Hello Solid'))
            $getRoot().clear().append(paragraph)
          })
        })
      }
    })
    return <div ref={el} testId="editor" contentEditable tabIndex={options.tabIndex} style={{ display: 'block', width: 400, height: 120 }} />
  }
  launched.app = mount(() => <Editor />)
  return launched
}

// Lexical keeps one reference-counted `selectionchange` listener per document, so an editor left mounted by an earlier
// probe would hide the registration (and the delivery) in the next one: every probe unmounts its root while the
// listener wrappers are still installed.
async function finish(launched: Launched) {
  try {
    launched.editor?.setRootElement(null)
    await settleAll(launched)
  } catch (error) {
    ;((report.cleanupErrors ??= []) as unknown[]).push(errorInfo(error))
  }
  launched.probe.restore()
}

function editorText(editor: LexicalEditor | undefined): string | null {
  if (editor === undefined) return null
  return editor.getEditorState().read(() => $getRoot().getTextContent())
}

// Lexical commits updates in a microtask; an unhandled rejection from one is a failure to record, not to hide.
async function settleAll(launched: Launched) {
  const pending: unknown[] = []
  const onRejection = (reason: unknown) => pending.push(reason)
  process.on('unhandledRejection', onRejection)
  const onUncaught = (error: unknown) => pending.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    await settle(launched.app)
    await settle(launched.app)
  } finally {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onUncaught)
  }
  for (const error of pending) launched.probe.errors.push({ phase: 'async', error: errorInfo(error) })
}

function summarize(launched: Launched) {
  const probe = launched.probe
  return {
    errors: probe.errors,
    editorText: editorText(launched.editor),
    painted: launched.app.renderer.getPaintedText(),
    updatesFired: probe.updates.length,
  }
}

describeNative('vanilla Lexical in @ghia/solid', () => {
  afterAll(() => {
    writeFileSync(new URL('./solid-report.json', import.meta.url), JSON.stringify(report, null, 2))
  })

  for (const variant of ['bare', 'richText', 'history', 'full'] as Variant[]) {
    it(`1. mount with ${variant}`, async () => {
      const launched = launch(variant)
      try {
        await settleAll(launched)
        report[`1-${variant}`] = summarize(launched)
        console.log(`1-${variant}`, JSON.stringify(report[`1-${variant}`], null, 1))
      } finally {
        await finish(launched)
      }
    })
  }

  it('1b. mount with full, no seed update', async () => {
    const launched = launch('full', { seed: false })
    try {
      await settleAll(launched)
      report['1b-noseed'] = summarize(launched)
    } finally {
      await finish(launched)
    }
  })

  it('2. painted text and the element tree Lexical built', async () => {
    const launched = launch('full')
    try {
      await settleAll(launched)
      report['2-tree'] = {
        painted: launched.app.renderer.getPaintedText(),
        root: launched.el ? dumpTree(launched.el) : null,
        rootProps: launched.el && {
          contentEditable: launched.el.contentEditable,
          isContentEditable: launched.el.isContentEditable,
          hasLexicalEditorExpando: Reflect.get(launched.el, '__lexicalEditor') !== undefined,
        },
        errors: launched.probe.errors,
      }
      console.log('2-tree', JSON.stringify(report['2-tree'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('3. listeners, selection access and DOM members that came back undefined or threw', async () => {
    const launched = launch('full', { proxyRoot: true })
    try {
      await settleAll(launched)
      const probe = launched.probe
      report['3-instrumentation'] = {
        errors: probe.errors,
        listeners: probe.listeners,
        getSelectionCalls: probe.getSelectionCalls,
        mutationObserve: probe.mutationObserve,
        undefinedReads: probe.undefinedReads,
        throwingReads: probe.throwingReads,
      }
      console.log('3', JSON.stringify(report['3-instrumentation'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('4. typing, Enter, Backspace and a composition', async () => {
    const launched = launch('full')
    try {
      await settleAll(launched)
      const probe = launched.probe
      const steps: Record<string, unknown> = {}
      const snapshot = () => ({
        editorText: editorText(launched.editor),
        painted: launched.app.renderer.getPaintedText(),
        domText: launched.el?.textContent,
        updatesFired: probe.updates.length,
      })
      const step = async (name: string, action: () => Promise<void> | void) => {
        const before = probe.invoked.length
        try {
          await action()
          await settleAll(launched)
        } catch (error) {
          steps[`${name}:error`] = errorInfo(error)
        }
        const reached: Record<string, number> = {}
        for (const call of probe.invoked.slice(before)) {
          const key = `${call.target}:${call.type}${call.defaultPrevented ? ' (defaultPrevented)' : ''}`
          reached[key] = (reached[key] ?? 0) + 1
        }
        steps[name] = { eventsReachingLexical: reached, ...snapshot() }
      }
      steps.initial = snapshot()
      await step('focus', () => focus(launched.app, query('[contenteditable]')))
      await step('type a', () => press(launched.app, 'a'))
      await step('type b', () => press(launched.app, 'b'))
      await step('type c', () => press(launched.app, 'c'))
      await step('Enter', () => press(launched.app, 'Enter'))
      await step('Backspace', () => press(launched.app, 'Backspace'))
      await step('composition mark+commit', () => {
        const id = launched.app.renderer.findByTestId('editor')!.id
        launched.app.renderer.simulateComposition(id, [
          { key: 'k', action: 'mark', text: 'k' },
          { key: 'Enter', action: 'commit', text: 'か' },
        ])
      })
      report['4-input'] = { steps, errors: probe.errors, allInvoked: probe.invoked.length }
      console.log('4', JSON.stringify(report['4-input'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('3b. DOM members Lexical source calls, present or missing on the Ghia DOM', async () => {
    const launched = launch('full')
    try {
      await settleAll(launched)
      const g = globalThis as any
      const el = launched.el as any
      const text = el.querySelector('span').firstChild
      const selection = g.getSelection()
      const check = (target: any, names: string[]) =>
        Object.fromEntries(names.map((name) => [name, name in Object(target) ? typeof target[name] : 'MISSING']))
      report['3b-members'] = {
        selection: check(selection, [
          'anchorNode', 'anchorOffset', 'focusNode', 'focusOffset', 'isCollapsed', 'rangeCount', 'type', 'direction',
          'getRangeAt', 'addRange', 'removeRange', 'removeAllRanges', 'setBaseAndExtent', 'collapse', 'extend', 'modify',
          'getComposedRanges', 'containsNode', 'selectAllChildren', 'toString',
        ]),
        document: check(g.document, [
          'createRange', 'createTreeWalker', 'execCommand', 'caretRangeFromPoint', 'caretPositionFromPoint',
          'elementFromPoint', 'activeElement', 'defaultView', 'createElement', 'createTextNode', 'createDocumentFragment',
          'getSelection', 'body', 'documentElement', 'queryCommandSupported', 'hasFocus', 'adoptedStyleSheets', 'readyState',
        ]),
        window: check(g, [
          'Range', 'Selection', 'InputEvent', 'KeyboardEvent', 'CompositionEvent', 'ClipboardEvent', 'DragEvent',
          'DataTransfer', 'DOMParser', 'Node', 'Text', 'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle',
          'navigator', 'queueMicrotask', 'requestAnimationFrame', 'getSelection', 'event', 'Event', 'FocusEvent', 'PointerEvent',
        ]),
        element: check(el, [
          'isContentEditable', 'contentEditable', 'getRootNode', 'getBoundingClientRect', 'closest', 'matches', 'attributes',
          'getAttributeNames', 'outerHTML', 'innerText', 'normalize', 'compareDocumentPosition', 'isConnected',
          'ownerDocument', 'scrollIntoView', 'attachShadow', 'spellcheck', 'setAttribute', 'removeAttribute', 'dataset',
          'parentElement', 'previousSibling', 'nextSibling', 'firstChild', 'lastChild', 'append', 'replaceChildren',
          'insertBefore', 'removeChild', 'replaceChild', 'cloneNode', 'contains', 'style', 'classList', 'className', 'dir',
        ]),
        textNode: check(text, [
          'nodeValue', 'textContent', 'data', 'splitText', 'length', 'getRootNode', 'compareDocumentPosition', 'isConnected',
          'parentNode', 'ownerDocument', 'normalize', 'cloneNode',
        ]),
        constructors: {
          Range: typeof g.Range, InputEvent: typeof g.InputEvent, KeyboardEvent: typeof g.KeyboardEvent,
          CompositionEvent: typeof g.CompositionEvent, ClipboardEvent: typeof g.ClipboardEvent, DataTransfer: typeof g.DataTransfer,
        },
        createRangeCall: await (async () => {
          try {
            return typeof g.document.createRange === 'function' ? String(g.document.createRange()) : 'MISSING'
          } catch (error) {
            return errorInfo(error)
          }
        })(),
        isContentEditableRead: el.isContentEditable,
      }
      console.log('3b', JSON.stringify(report['3b-members'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('4b. typing into the editable when it has tabIndex=0 (focusable)', async () => {
    const launched = launch('full', { tabIndex: 0 })
    try {
      await settleAll(launched)
      const probe = launched.probe
      const steps: Record<string, unknown> = {}
      const step = async (name: string, action: () => Promise<void> | void) => {
        const before = probe.invoked.length
        const errorsBefore = probe.errors.length
        try {
          await action()
          await settleAll(launched)
        } catch (error) {
          steps[`${name}:error`] = errorInfo(error)
        }
        const reached: Record<string, number> = {}
        for (const call of probe.invoked.slice(before)) {
          const key = `${call.target}:${call.type}${call.defaultPrevented ? ' (defaultPrevented)' : ''}`
          reached[key] = (reached[key] ?? 0) + 1
        }
        steps[name] = {
          eventsReachingLexical: reached,
          activeElement: (document.activeElement as HTMLElement | null)?.nodeName,
          activeIsRoot: document.activeElement === launched.el,
          editorText: editorText(launched.editor),
          painted: launched.app.renderer.getPaintedText(),
          domText: launched.el.textContent,
          updatesFired: probe.updates.length,
          newErrors: probe.errors.slice(errorsBefore),
        }
      }
      await step('focus', () => focus(launched.app, query('[contenteditable]')))
      await step('type a', () => press(launched.app, 'a'))
      await step('Enter', () => press(launched.app, 'Enter'))
      await step('Backspace', () => press(launched.app, 'Backspace'))
      await step('composition mark+commit', () => {
        const id = launched.app.renderer.findByTestId('editor')!.id
        launched.app.renderer.simulateComposition(id, [
          { key: 'k', action: 'mark', text: 'k' },
          { key: 'Enter', action: 'commit', text: 'か' },
        ])
      })
      report['4b-tabindex'] = { steps, errors: probe.errors }
      console.log('4b', JSON.stringify(report['4b-tabindex'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('4c. synthetic events dispatched at the root reach Lexical', async () => {
    const launched = launch('full', { tabIndex: 0 })
    try {
      await settleAll(launched)
      const probe = launched.probe
      const g = globalThis as any
      const steps: Record<string, unknown> = {}
      await focus(launched.app, launched.el)
      const dispatch = async (name: string, target: any, make: () => Event) => {
        const before = probe.invoked.length
        const errorsBefore = probe.errors.length
        const result: Record<string, unknown> = {}
        try {
          const event = make()
          result.dispatchReturned = target.dispatchEvent(event)
          result.defaultPrevented = event.defaultPrevented
        } catch (error) {
          result.dispatchError = errorInfo(error)
        }
        await settleAll(launched)
        const reached: Record<string, number> = {}
        for (const call of probe.invoked.slice(before)) {
          const key = `${call.target}:${call.type}${call.defaultPrevented ? ' (defaultPrevented)' : ''}`
          reached[key] = (reached[key] ?? 0) + 1
        }
        steps[name] = {
          ...result,
          eventsReachingLexical: reached,
          editorText: editorText(launched.editor),
          painted: launched.app.renderer.getPaintedText(),
          newErrors: probe.errors.slice(errorsBefore),
        }
      }
      const ctor = (name: string) => (typeof g[name] === 'function' ? g[name] : Event)
      await dispatch('selectionchange on document', g.document, () => new Event('selectionchange'))
      await dispatch('focus on root', launched.el, () => new (ctor('FocusEvent'))('focus'))
      await dispatch('keydown a', launched.el, () => new (ctor('KeyboardEvent'))('keydown', { key: 'a', bubbles: true, cancelable: true }))
      await dispatch('keydown Enter', launched.el, () => new (ctor('KeyboardEvent'))('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      await dispatch('beforeinput insertText', launched.el, () => {
        const event: any = new (ctor('InputEvent'))('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true })
        if (event.inputType === undefined) event.inputType = 'insertText'
        return event
      })
      await dispatch('input', launched.el, () => new (ctor('InputEvent'))('input', { inputType: 'insertText', data: 'x', bubbles: true }))
      await dispatch('compositionstart', launched.el, () => new (ctor('CompositionEvent'))('compositionstart', { data: '', bubbles: true }))
      await dispatch('compositionend', launched.el, () => new (ctor('CompositionEvent'))('compositionend', { data: 'か', bubbles: true }))
      await dispatch('pointerdown on root', launched.el, () => new (ctor('PointerEvent'))('pointerdown', { bubbles: true }))
      report['4c-synthetic'] = { steps, constructors: { InputEvent: typeof g.InputEvent, KeyboardEvent: typeof g.KeyboardEvent, CompositionEvent: typeof g.CompositionEvent, FocusEvent: typeof g.FocusEvent, PointerEvent: typeof g.PointerEvent }, errors: probe.errors }
      console.log('4c', JSON.stringify(report['4c-synthetic'], null, 1))
    } finally {
      await finish(launched)
    }
  })

  it('5. editor.update replaces the content', async () => {
    const launched = launch('full')
    try {
      await settleAll(launched)
      const before = launched.probe.updates.length
      const result: Record<string, unknown> = { paintedBefore: launched.app.renderer.getPaintedText(), updatesBefore: before }
      try {
        launched.editor!.update(() => {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode('Updated'))
          $getRoot().clear().append(paragraph)
        })
      } catch (error) {
        result.updateError = errorInfo(error)
      }
      await settleAll(launched)
      Object.assign(result, {
        paintedAfter: launched.app.renderer.getPaintedText(),
        editorText: editorText(launched.editor),
        domText: launched.el?.textContent,
        updateListenerFiredAgain: launched.probe.updates.length > before,
        updatesAfter: launched.probe.updates.length,
        errors: launched.probe.errors,
      })
      report['5-update'] = result
      console.log('5', JSON.stringify(result, null, 1))
    } finally {
      await finish(launched)
    }
  })
})
