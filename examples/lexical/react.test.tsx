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
  $getSelection,
  $isRangeSelection,
  $selectAll,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical'
import { ListItemNode, ListNode, INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/react/testing'
import { settle } from '../base-ui/harness'
import { markerInk, markerPixels, readScreenshot } from './screenshot'

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

  it('7. a click on the editable puts the caret where it landed: the selection moves there and typing goes there', async () => {
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    // The caret is at the end, so a click that does nothing leaves it there.
    const length = (textNode as Text).data.length
    selection.setBaseAndExtent(textNode, length, textNode, length)
    await nextTask()
    await settle(root)
    const first = paragraphs()[0]
    const box = rootElement().getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(box.x + 1, box.y + 8)
    root.renderer.nativeSimulateMouseUp(box.x + 1, box.y + 8)
    await nextTask()
    await settle(root)
    expect(uncaught).toEqual([])
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
      // Lexical keeps zero-width spaces around the text of a composition.
      expect(rootElement().textContent?.replaceAll('\u200b', '')).toBe(`Updated${marked.text}`)
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

  it('11. Option+Backspace deletes a word and Shift+ArrowLeft extends: Lexical and the DOM agree', async () => {
    lexicalEditor().update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('one two three'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle(root)
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 13, textNode, 13)
    await nextTask()
    await settle(root)
    await press('Alt+Backspace')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['one two '])
    expect(rootElement().textContent).toBe('one two ')
    expect(painted()).toContain('one two ')
    await press('Shift+ArrowLeft Shift+ArrowLeft')
    await nextTask()
    await settle(root)
    expect(lexicalEditor().getEditorState().read(() => $getSelection()?.getTextContent())).toBe('o ')
    expect(selection.toString()).toBe('o ')
    expect(uncaught).toEqual([])
  })

  it('12. a click into the middle of a word puts the caret there: Lexical\'s selection is at the offset and typing lands in it', async () => {
    lexicalEditor().update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('one two three'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle(root)
    const textNode = rootElement().querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    // Where the caret is painted at offset 5, between `t` and `wo`; a click a pixel to its right is nearest to it.
    const range = document.createRange()
    range.setStart(textNode, 5)
    range.collapse(true)
    const at = range.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(at.x + 1, at.y + at.height / 2)
    root.renderer.nativeSimulateMouseUp(at.x + 1, at.y + at.height / 2)
    await nextTask()
    await settle(root)
    expect(lexicalEditor().getEditorState().read(() => {
      const selection = $getSelection()
      return $isRangeSelection(selection) ? [selection.anchor.offset, selection.focus.offset, selection.isCollapsed()] : null
    })).toEqual([5, 5, true])
    await press('X')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['one tXwo three'])
    expect(rootElement().textContent).toBe('one tXwo three')
    expect(painted()).toContain('one tXwo three')
    expect(uncaught).toEqual([])
  })

  it('13. a click on an empty paragraph puts the caret in it: Lexical\'s selection is that paragraph and typing lands in it', async () => {
    lexicalEditor().update(() => {
      const paragraph = (text: string) => {
        const node = $createParagraphNode()
        if (text !== '') node.append($createTextNode(text))
        return node
      }
      $getRoot().clear().append(paragraph('one'), paragraph(''), paragraph('three'))
    })
    await nextTask()
    await settle(root)
    const empty = rootElement().querySelectorAll('p')[1]
    if (empty === undefined) throw new Error('no second paragraph')
    expect(empty.textContent).toBe('')
    const at = empty.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(at.x + 4, at.y + at.height / 2)
    root.renderer.nativeSimulateMouseUp(at.x + 4, at.y + at.height / 2)
    await nextTask()
    await settle(root)
    expect(lexicalEditor().getEditorState().read(() => {
      const selection = $getSelection()
      return $isRangeSelection(selection) ? [selection.anchor.getNode().getKey() === $getRoot().getChildAtIndex(1)?.getKey(), selection.isCollapsed()] : null
    })).toEqual([true, true])
    await press('X')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['one', 'X', 'three'])
    expect(rootElement().querySelectorAll('p')[1]?.textContent).toBe('X')
    expect(painted()).toContain('X')
    expect(uncaught).toEqual([])
  })

  it('14. ArrowDown and ArrowUp stop in empty paragraphs, a trailing one included: Lexical\'s selection is that paragraph and typing lands in it', async () => {
    lexicalEditor().update(() => {
      const paragraph = (text: string) => {
        const node = $createParagraphNode()
        if (text !== '') node.append($createTextNode(text))
        return node
      }
      $getRoot().clear().append(paragraph('one two'), paragraph(''), paragraph('three four'), paragraph(''))
    })
    await nextTask()
    await settle(root)
    const first = rootElement().querySelector('span')?.firstChild
    if (first === null || first === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(first, 4, first, 4)
    await nextTask()
    await settle(root)
    const paragraphIndex = (): number | null =>
      lexicalEditor().getEditorState().read(() => {
        const lexical = $getSelection()
        if (!$isRangeSelection(lexical) || !lexical.isCollapsed()) return null
        return $getRoot().getChildren().findIndex((child) => child.getKey() === lexical.anchor.getNode().getTopLevelElementOrThrow().getKey())
      })
    const visit = async (keys: string, expected: number): Promise<void> => {
      await press(keys)
      await nextTask()
      await settle(root)
      expect(paragraphIndex()).toBe(expected)
    }
    await visit('ArrowDown', 1)
    expect(lexicalEditor().getEditorState().read(() => ($getSelection() as { anchor: { offset: number } }).anchor.offset)).toBe(0)
    await visit('ArrowDown', 2)
    await visit('ArrowDown', 3)
    await visit('ArrowDown', 3)
    await visit('ArrowUp', 2)
    await visit('ArrowUp', 1)
    await visit('ArrowUp', 0)
    await visit('ArrowDown', 1)
    await press('X')
    await nextTask()
    await settle(root)
    expect(paragraphs()).toEqual(['one two', 'X', 'three four', ''])
    expect(uncaught).toEqual([])
  })

  it('15. keys that AppKit queues before one tick each get their own microtask checkpoint: Lexical commits every one', async () => {
    lexicalEditor().update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('Hello'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle(root)
    const first = rootElement().querySelector('span')?.firstChild
    if (first === null || first === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(first, 5, first, 5)
    await nextTask()
    await settle(root)
    // Three letters, each a keyDown and a keyUp, are in AppKit's queue before the first pump, as when a slow frame
    // or key repeat leaves several waiting. A pump sends one key event and the loop turns before the next.
    root.renderer.postNativeKeys('abc')
    // A keyDown and a keyUp for each of the three letters, and one pump more.
    for (let pump = 0; pump < 7; pump++) {
      root.renderer.pumpNativeEvents()
      await nextTask()
    }
    await settle(root)
    expect(lexicalText()).toBe('Helloabc')
    expect(paragraphs()).toEqual(['Helloabc'])
    expect(rootElement().textContent).toBe('Helloabc')
    expect(painted()).toContain('Helloabc')
    expect(uncaught).toEqual([])
  })
})

// Two editors in one window, and the clipboard between them. Keys go through the real path (AppKit's key equivalent,
// the GPUI action, the page's copy, cut and paste events); the test renderer keeps its own clipboard, never the system one.
const pair: LexicalEditor[] = []

function CaptureAt(props: { index: number }): null {
  const [captured] = useLexicalComposerContext()
  pair[props.index] = captured
  return null
}

function Pane(props: { index: number }): ReactNode {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: `lexical-clipboard-${props.index}`,
        onError: (error: Error) => {
          throw error
        },
      }}
    >
      <CaptureAt index={props.index} />
      <RichTextPlugin
        contentEditable={<ContentEditable style={{ display: 'block', width: 300, minHeight: 40 }} />}
        ErrorBoundary={LexicalErrorBoundary}
      />
    </LexicalComposer>
  )
}

function TwoEditors(): ReactNode {
  return (
    <div>
      <Pane index={0} />
      <Pane index={1} />
    </div>
  )
}

/** Each top-level block's text runs, `[text, isBold]`. */
function runs(target: LexicalEditor): Array<Array<[string, boolean]>> {
  return target.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((block) => (block as ElementNode).getChildren().map((child): [string, boolean] => [child.getTextContent(), (child as TextNode).hasFormat('bold')])),
  )
}

function blocks(target: LexicalEditor): string[] {
  return target.getEditorState().read(() => $getRoot().getChildren().map((child) => child.getTextContent()))
}

describeNative('Lexical (React bindings) clipboard between two editors on Ghia', () => {
  let window: ReturnType<typeof createTestRoot>
  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const idle = async (): Promise<void> => {
    await nextTask()
    await settle(window)
    await nextTask()
    await settle(window)
  }
  const press = async (keys: string): Promise<void> => {
    for (const key of keys.split(' ')) {
      window.renderer.simulateKeystrokes(key)
      await idle()
    }
  }
  const clipboard = (): Record<string, string> => Object.fromEntries(window.renderer.readClipboard().map((item) => [item.type, item.data]))
  const focus = async (target: LexicalEditor): Promise<void> => {
    target.focus()
    await idle()
  }
  const rootOf = (target: LexicalEditor): HTMLElement => {
    const element = target.getRootElement()
    if (element === null) throw new Error('the editor has no root element')
    return element
  }
  const empty = async (target: LexicalEditor): Promise<void> => {
    target.update(() => {
      const paragraph = $createParagraphNode()
      $getRoot().clear().append(paragraph)
      paragraph.select()
    })
    await idle()
  }

  beforeAll(async () => {
    window = createTestRoot({ width: 640, height: 480, onUncaughtError: (error: unknown) => uncaught.push(error) })
    window.render(<TwoEditors />)
    await idle()
  })

  afterAll(() => {
    window.unmount()
  })

  it('16. Cmd+C in one editor and Cmd+V in the other carry the text and its bold, as Chrome does', async () => {
    const [a, b] = pair as [LexicalEditor, LexicalEditor]
    await focus(a)
    await press('H e l l o Space')
    await press('ControlOrMeta+b')
    await press('w o r l d')
    expect(runs(a)).toEqual([[['Hello ', false], ['world', true]]])
    await press('ControlOrMeta+a')
    await press('ControlOrMeta+c')
    const copied = clipboard()
    expect(Object.keys(copied).sort()).toEqual(['application/x-lexical-editor', 'text/html', 'text/plain'])
    expect(copied['text/plain']).toBe('Hello world')
    expect(copied['text/html']).toContain('world')
    expect(JSON.parse(copied['application/x-lexical-editor'] as string).namespace).toBe('lexical-clipboard-0')
    await focus(b)
    await press('ControlOrMeta+v')
    expect(blocks(b)).toEqual(['Hello world'])
    expect(runs(b)).toEqual([[['Hello ', false], ['world', true]]])
    expect(rootOf(b).querySelector('strong')?.textContent).toBe('world')
    expect(rootOf(a).querySelectorAll('strong').length).toBe(1)
    expect(window.renderer.getPaintedText().join('\n')).toContain('Hello world')
    expect(uncaught).toEqual([])
  })

  it('17. pasting text/plain with two lines gives the paragraphs Lexical makes of it, and the default insertion does not also run', async () => {
    const [, b] = pair as [LexicalEditor, LexicalEditor]
    await empty(b)
    await focus(b)
    window.renderer.writeClipboard([{ type: 'text/plain', data: 'line one\nline two' }])
    await press('ControlOrMeta+v')
    expect(blocks(b)).toEqual(['line one', 'line two'])
    expect(rootOf(b).querySelectorAll('p').length).toBe(2)
    expect(rootOf(b).querySelectorAll('br').length).toBe(0)
    expect(uncaught).toEqual([])
  })

  it('18. pasting HTML from another app goes through DOMParser and Lexical\'s import: "there" is bold', async () => {
    const [, b] = pair as [LexicalEditor, LexicalEditor]
    await empty(b)
    await focus(b)
    window.renderer.writeClipboard([
      { type: 'text/html', data: "<meta charset='utf-8'><p>Hi <b>there</b></p>" },
      { type: 'text/plain', data: 'Hi there' },
    ])
    await press('ControlOrMeta+v')
    expect(runs(b)).toEqual([[['Hi ', false], ['there', true]]])
    expect(rootOf(b).querySelector('strong')?.textContent).toBe('there')
    expect(uncaught).toEqual([])
  })

  it('19. Cmd+X takes a word out and puts it on the clipboard; the Edit menu\'s Paste puts it back somewhere else', async () => {
    const [a, b] = pair as [LexicalEditor, LexicalEditor]
    await empty(a)
    await focus(a)
    await press('o n e Space t w o Space t h r e e')
    expect(blocks(a)).toEqual(['one two three'])
    const text = rootOf(a).querySelector('span')?.firstChild
    if (text === null || text === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(text, 4, text, 8)
    await idle()
    await press('ControlOrMeta+x')
    expect(clipboard()['text/plain']).toBe('two ')
    expect(blocks(a)).toEqual(['one three'])
    expect(rootOf(a).textContent).toBe('one three')
    await empty(b)
    await focus(b)
    expect(window.renderer.simulateMenuAction('paste')).toBe(true)
    await idle()
    expect(blocks(b)).toEqual(['two '])
    expect(blocks(a)).toEqual(['one three'])
    expect(uncaught).toEqual([])
  })
})

// Lists made through Lexical's own commands paint the marker of each item: Lexical writes `<ul>` and `<ol>` with
// `<li value="n">`, and the number or bullet is Ghia's, not Lexical's.
let listEditor: LexicalEditor | undefined

function CaptureListEditor(): null {
  ;[listEditor] = useLexicalComposerContext()
  return null
}

function seedItems(): void {
  for (const text of ['first', 'second', 'third']) $getRoot().append($createParagraphNode().append($createTextNode(text)))
}

function ListApp(): ReactNode {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'lexical-react-lists',
        nodes: [ListNode, ListItemNode],
        onError: (error: Error) => {
          throw error
        },
        editorState: seedItems,
      }}
    >
      <CaptureListEditor />
      <RichTextPlugin
        contentEditable={<ContentEditable style={{ display: 'block', width: 400, minHeight: 40, backgroundColor: '#ffffff', color: '#000000' }} />}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <ListPlugin />
    </LexicalComposer>
  )
}

describeNative('Lexical (React bindings) lists on Ghia', () => {
  let window: ReturnType<typeof createTestRoot>
  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const idle = async (): Promise<void> => {
    await nextTask()
    await settle(window)
    await nextTask()
    await settle(window)
  }

  beforeAll(async () => {
    window = createTestRoot({ width: 480, height: 320, onUncaughtError: (error: unknown) => uncaught.push(error) })
    window.render(<ListApp />)
    await idle()
  })

  afterAll(() => {
    window.unmount()
  })

  const items = (): HTMLElement[] => [...(listEditor!.getRootElement() as HTMLElement).querySelectorAll('li')] as HTMLElement[]
  const markers = (name: string): { ink: number[]; shapes: string[] } => {
    const file = `${import.meta.dirname}/screens/lists-react-${name}.png`
    window.renderer.captureScreenshot(file)
    const shot = readScreenshot(file)
    const scale = shot.width / window.renderer.getWindowSize().width
    const boxes = items().map((item) => item.getBoundingClientRect())
    return { ink: boxes.map((box) => markerInk(shot, scale, box)), shapes: boxes.map((box) => markerPixels(shot, scale, box)) }
  }

  it('paints no marker for a paragraph, a bullet for each item of an unordered list and its number for each of an ordered one', async () => {
    expect(items().length).toBe(0)
    listEditor!.update(() => $selectAll())
    await idle()
    listEditor!.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
    await idle()
    expect(items().length).toBe(3)
    const bulleted = markers('bulleted')
    expect(bulleted.ink.every((ink) => ink > 0), `a bullet in front of every item: ${bulleted.ink}`).toBe(true)
    expect(new Set(bulleted.shapes).size, 'every bullet is the same').toBe(1)

    listEditor!.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
    await idle()
    expect(items().length).toBe(3)
    const numbered = markers('numbered')
    expect(numbered.ink.every((ink) => ink > 0), `a number in front of every item: ${numbered.ink}`).toBe(true)
    expect(new Set(numbered.shapes).size, 'every number is another').toBe(3)
    expect(numbered.shapes).not.toEqual(bulleted.shapes)
    expect(uncaught).toEqual([])
  })
})
