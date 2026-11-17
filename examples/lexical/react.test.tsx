import { writeFileSync } from 'node:fs'
import type { ReactNode } from 'react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  IS_ANDROID,
  IS_APPLE,
  IS_CHROME,
  IS_FIREFOX,
  IS_IOS,
  IS_SAFARI,
  type LexicalEditor,
} from 'lexical'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/react/testing'
import { settle } from '../base-ui/harness'

// Real Lexical (LexicalComposer, RichTextPlugin, ContentEditable, HistoryPlugin, OnChangePlugin) running unchanged on
// Ghia's contenteditable support. Runs on the plugins an app's Vite config has, which `vitest.config.ts` cannot share:
// the `ghia()` environment inlines safe-mdx's browser-only dependencies, which the other examples' tests would trip on.
// `react-report.json` records what the run observed; the assertions are the test.

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type Json = Record<string, unknown>
const report: Json = {}
const note = (key: string, value: unknown): void => {
  report[key] = value
}

const errorText = (error: unknown): Json => {
  if (!(error instanceof Error)) return { thrown: String(error) }
  return { name: error.name, message: error.message, stack: (error.stack ?? '').split('\n').slice(0, 10) }
}

const uncaught: unknown[] = []
const changes: unknown[] = []
let editor: LexicalEditor | undefined

function CaptureEditor(): null {
  ;[editor] = useLexicalComposerContext()
  return null
}

function seed(): void {
  const paragraph = $createParagraphNode()
  paragraph.append($createTextNode('Hello Lexical'))
  $getRoot().append(paragraph)
}

function App(): ReactNode {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'lexical-react',
        onError: (error: Error) => {
          throw error
        },
        editorState: seed,
      }}
    >
      <CaptureEditor />
      <RichTextPlugin contentEditable={<ContentEditable />} ErrorBoundary={LexicalErrorBoundary} />
      <HistoryPlugin />
      <OnChangePlugin onChange={(state) => changes.push(state.toJSON())} />
    </LexicalComposer>
  )
}

function lexicalEditor(): LexicalEditor {
  if (editor === undefined) throw new Error('the Lexical editor was never captured')
  return editor
}

function rootElement(): HTMLElement {
  const root = lexicalEditor().getRootElement()
  if (root === null) throw new Error('the editor has no root element')
  return root
}

/** Lexical's text, one paragraph per entry. */
function paragraphs(): string[] {
  return lexicalEditor()
    .getEditorState()
    .read(() => $getRoot().getChildren().map((child) => child.getTextContent()))
}

function lexicalText(): string {
  return lexicalEditor().getEditorState().read(() => $getRoot().getTextContent())
}

describeNative('Lexical (React bindings) on Ghia', () => {
  let root: ReturnType<typeof createTestRoot>
  const beforeInputTargets: unknown[] = []
  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const painted = (): string => root.renderer.getPaintedText().join('\n')
  const press = async (keys: string): Promise<void> => {
    for (const key of keys.split(' ')) {
      root.renderer.simulateKeystrokes(key)
      await settle(root)
    }
  }
  const snapshot = (): Json => ({ lexical: paragraphs(), painted: root.renderer.getPaintedText(), dom: rootElement().textContent })

  beforeAll(async () => {
    // The Element prototype only exists once an element does; a throwaway root supplies one so Lexical's
    // `addEventListener` calls can be observed from its first render on.
    const sample = createTestRoot({ width: 100, height: 100 })
    sample.render(<div id="listener-sample">x</div>)
    const element = document.querySelector('#listener-sample') as HTMLElement
    let owner: object | null = element
    while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'addEventListener')) owner = Object.getPrototypeOf(owner)
    if (owner === null) throw new Error('addEventListener is not on the element prototype chain')
    const add = (owner as EventTarget).addEventListener
    ;(owner as EventTarget).addEventListener = function (this: unknown, type: string, ...rest: [never, never]) {
      if (type === 'beforeinput') beforeInputTargets.push(this)
      return add.call(this as EventTarget, type, ...rest)
    } as never
    sample.unmount()

    root = createTestRoot({ width: 640, height: 480, onUncaughtError: (error: unknown) => uncaught.push(error) })
    root.render(<App />)
    await settle(root)
    await nextTask()
    await settle(root)
  })

  afterAll(() => {
    root.unmount()
    writeFileSync(new URL('./react-report.json', import.meta.url), JSON.stringify(report, null, 2))
  })

  it('1. mounts without an error and paints "Hello Lexical"', () => {
    expect(uncaught).toEqual([])
    expect(lexicalText()).toBe('Hello Lexical')
    expect(painted()).toContain('Hello Lexical')
    expect(rootElement().isContentEditable).toBe(true)
    expect(rootElement().querySelectorAll('p').length).toBe(1)
    // Lexical's CAN_USE_BEFORE_INPUT is this expression, evaluated when the module loads.
    expect('getTargetRanges' in new InputEvent('input')).toBe(true)
    expect(CAN_USE_BEFORE_INPUT).toBe(true)
    expect(beforeInputTargets.includes(rootElement())).toBe(true)
    note('1.mount', {
      painted: root.renderer.getPaintedText(),
      lexicalText: lexicalText(),
      CAN_USE_BEFORE_INPUT,
      beforeInputListenerOnRoot: beforeInputTargets.includes(rootElement()),
      rootAttributes: Object.fromEntries(rootElement().getAttributeNames().map((name) => [name, rootElement().getAttribute(name)])),
    })
  })

  it('9. records navigator and the Lexical environment flags', () => {
    note('9.environment', {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      // As Lexical.dev.js computes them from the two strings above (testPlatform / testUserAgent, :59-113).
      flags: { CAN_USE_DOM, CAN_USE_BEFORE_INPUT, IS_APPLE, IS_SAFARI, IS_CHROME, IS_FIREFOX, IS_IOS, IS_ANDROID },
    })
    expect(typeof navigator.userAgent).toBe('string')
    expect(typeof navigator.platform).toBe('string')
  })

  it('2. root.focus() makes the root the active element', async () => {
    rootElement().focus()
    await settle(root)
    expect(document.activeElement === rootElement()).toBe(true)
  })

  it('3. typing "abc" at a caret inside "Hello" reaches Lexical state and paint', async () => {
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    const changesBefore = changes.length
    selection.setBaseAndExtent(textNode, 5, textNode, 5)
    await nextTask()
    await settle(root)
    note('3.selectionAfterSet', { anchorOffset: selection.anchorOffset, anchorIsText: selection.anchorNode === textNode, type: selection.type })
    await press('a b c')
    await nextTask()
    await settle(root)
    note('3.type-abc', { ...snapshot(), onChangeCalls: changes.length - changesBefore })
    expect(lexicalText()).toBe('Helloabc Lexical')
    expect(painted()).toContain('Helloabc Lexical')
    expect(changes.length).toBeGreaterThan(changesBefore)
    expect(uncaught).toEqual([])
  })

  it('4. Backspace removes one character from Lexical state and paint', async () => {
    await press('Backspace')
    await nextTask()
    await settle(root)
    note('4.backspace', snapshot())
    expect(lexicalText()).toBe('Helloab Lexical')
    expect(painted()).toContain('Helloab Lexical')
  })

  it('5. Enter adds a paragraph', async () => {
    await press('Enter')
    await nextTask()
    await settle(root)
    note('5.enter', { ...snapshot(), paragraphElements: rootElement().querySelectorAll('p').length })
    expect(paragraphs().length).toBe(2)
    expect(rootElement().querySelectorAll('p').length).toBe(2)
    const text = painted()
    expect(text).toContain('Helloab')
    expect(text).toContain(' Lexical')
  })

  it('6. undo through HistoryPlugin (recorded, not required)', async () => {
    const before = snapshot()
    let error: unknown
    try {
      root.renderer.simulateKeystrokes('ControlOrMeta+z')
      await nextTask()
      await settle(root)
    } catch (thrown) {
      error = thrown
    }
    note('6.undo', { before, after: snapshot(), threw: error === undefined ? null : errorText(error) })
    expect(error).toBeUndefined()
  })

  it('7. a click on the editable does not throw and the editor still updates', async () => {
    const box = rootElement().getBoundingClientRect()
    let error: unknown
    try {
      root.renderer.nativeSimulateMouseDown(box.x + 10, box.y + 8)
      root.renderer.nativeSimulateMouseUp(box.x + 10, box.y + 8)
      await nextTask()
      await settle(root)
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeUndefined()
    expect(uncaught).toEqual([])
    const before = lexicalText()
    await press('z')
    await nextTask()
    await settle(root)
    note('7.click', { threw: error === undefined ? null : errorText(error), before, after: snapshot(), activeIsRoot: document.activeElement === rootElement() })
    expect(lexicalText()).not.toBe(before)
    expect(lexicalText()).toContain('z')
  })

  it('8. editor.update replacing the content paints "Updated"', async () => {
    const changesBefore = changes.length
    lexicalEditor().update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('Updated'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle(root)
    note('8.update', { ...snapshot(), onChangeCalls: changes.length - changesBefore })
    expect(lexicalText()).toBe('Updated')
    expect(painted()).toContain('Updated')
    expect(changes.length).toBeGreaterThan(changesBefore)
  })
})
