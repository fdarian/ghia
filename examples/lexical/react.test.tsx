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
  type LexicalEditor,
} from 'lexical'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/react/testing'
import { settle } from '../base-ui/harness'

// Real Lexical (LexicalComposer, RichTextPlugin, ContentEditable, HistoryPlugin, OnChangePlugin) running unchanged on
// Ghia's contenteditable support. Runs on the plugins an app's Vite config has, which `vitest.config.ts` cannot share:
// the `ghia()` environment inlines safe-mdx's browser-only dependencies, which the other examples' tests would trip on.
//

const describeNative = hasNativeTestRenderer ? describe : describe.skip

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
  })

  it('9. exposes the DOM the Lexical environment flags read', () => {
    expect(CAN_USE_DOM).toBe(true)
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
    await press('a b c')
    await nextTask()
    await settle(root)
    expect(lexicalText()).toBe('Helloabc Lexical')
    expect(painted()).toContain('Helloabc Lexical')
    expect(changes.length).toBeGreaterThan(changesBefore)
    expect(uncaught).toEqual([])
  })

  it('4. Backspace removes one character from Lexical state and paint', async () => {
    await press('Backspace')
    await nextTask()
    await settle(root)
    expect(lexicalText()).toBe('Helloab Lexical')
    expect(painted()).toContain('Helloab Lexical')
  })

  it('5. Enter adds a paragraph', async () => {
    await press('Enter')
    await nextTask()
    await settle(root)
    expect(paragraphs().length).toBe(2)
    expect(rootElement().querySelectorAll('p').length).toBe(2)
    const text = painted()
    expect(text).toContain('Helloab')
    expect(text).toContain(' Lexical')
  })

  it('6. undo through HistoryPlugin takes the Enter back', async () => {
    expect(paragraphs()).toEqual(['Helloab', ' Lexical'])
    root.renderer.simulateKeystrokes('ControlOrMeta+z')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['Helloab Lexical'])
    expect(rootElement().textContent).toBe('Helloab Lexical')
    expect(painted()).toContain('Helloab Lexical')
    expect(uncaught).toEqual([])
  })

  it('7. a click on the editable is harmless: the selection stays where it was put and typing goes there', async () => {
    // Put the caret at the start explicitly, so nothing depends on where an earlier step left it.
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 0, textNode, 0)
    await nextTask()
    await settle(root)
    const first = paragraphs()[0]
    const box = rootElement().getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(box.x + 10, box.y + 8)
    root.renderer.nativeSimulateMouseUp(box.x + 10, box.y + 8)
    await nextTask()
    await settle(root)
    expect(uncaught).toEqual([])
    // A click in an editing host does not move the node selection yet (deviations.md), so it still sits at the start.
    expect([selection.anchorNode === textNode, selection.anchorOffset, selection.isCollapsed]).toEqual([true, 0, true])
    expect(document.activeElement === rootElement()).toBe(true)
    await press('z')
    await nextTask()
    await settle(root)
    expect(paragraphs()[0]).toBe(`z${first}`)
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
    expect(lexicalText()).toBe('Updated')
    expect(painted()).toContain('Updated')
    expect(changes.length).toBeGreaterThan(changesBefore)
  })

  it('10. an input method composes: Lexical gets the committed text once, and the DOM and Lexical agree after every step', async () => {
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 7, textNode, 7)
    await nextTask()
    await settle(root)
    const id = root.renderer.getFocusedElementId()
    if (id === null) throw new Error('the editable root has no focus')
    const events: string[] = []
    for (const type of ['compositionstart', 'compositionend']) rootElement().addEventListener(type, () => events.push(type))
    const step = (key: string, text: string) => ({ key, action: 'mark' as const, text })
    for (const marked of [step('k', 'k'), step('a', 'か'), step('n', 'かn'), step('a', 'かな')]) {
      root.renderer.simulateComposition(id, [marked])
      await nextTask()
      await settle(root)
      expect(rootElement().textContent).toBe(`Updated${marked.text}`)
    }
    root.renderer.simulateComposition(id, [{ key: 'Enter', action: 'commit', text: 'かな' }])
    await nextTask()
    await settle(root)
    expect(events).toEqual(['compositionstart', 'compositionend'])
    expect(paragraphs()).toEqual(['Updatedかな'])
    expect(rootElement().textContent).toBe('Updatedかな')
    expect(painted()).toContain('Updatedかな')
    await press('!')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['Updatedかな!'])
    expect(uncaught).toEqual([])
  })
})
