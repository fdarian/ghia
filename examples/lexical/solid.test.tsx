import { createRoot, onMount } from 'solid-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $selectAll,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  createEditor,
  type ElementNode,
  type LexicalEditor,
  type TextNode,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode, registerList } from '@lexical/list'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/solid/testing'
import { markerInk, markerPixels, readScreenshot } from './screenshot'

// Vanilla Lexical (createEditor, registerRichText, registerHistory, setRootElement) inside a @ghia/solid component,
// running unchanged on Ghia's contenteditable support. The editor lives across the steps, so this file mounts its own root instead of using
// `../solid-harness`, whose `mount` is unmounted after every test.

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('vanilla Lexical in @ghia/solid on Ghia', () => {
  const uncaught: unknown[] = []
  const updates: unknown[] = []
  const beforeInputTargets: unknown[] = []
  let root: ReturnType<typeof createTestRoot>
  let disposeUi: () => void
  let editor: LexicalEditor
  let element: HTMLElement
  const unregister: Array<() => void> = []

  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const settle = async (): Promise<void> => {
    await nextTask()
    root.renderer.dispatchNativeEvents()
    root.renderer.advanceTime(10)
    root.renderer.drawFrame()
    root.renderer.flush()
  }
  const painted = (): string => root.renderer.getPaintedText().join('\n')
  const press = async (keys: string): Promise<void> => {
    for (const key of keys.split(' ')) {
      root.renderer.simulateKeystrokes(key)
      await settle()
    }
  }
  const paragraphs = (): string[] => editor.getEditorState().read(() => $getRoot().getChildren().map((child) => child.getTextContent()))
  const lexicalText = (): string => editor.getEditorState().read(() => $getRoot().getTextContent())

  beforeAll(async () => {
    root = createTestRoot({ width: 640, height: 480, onUncaughtError: (error: unknown) => uncaught.push(error) })
    function Editor() {
      let el!: HTMLDivElement
      onMount(() => {
        element = el
        let owner: object | null = el
        while (owner !== null && !Object.prototype.hasOwnProperty.call(owner, 'addEventListener')) owner = Object.getPrototypeOf(owner)
        if (owner === null) throw new Error('addEventListener is not on the element prototype chain')
        const add = (owner as EventTarget).addEventListener
        ;(owner as EventTarget).addEventListener = function (this: unknown, type: string, ...rest: [never, never]) {
          if (type === 'beforeinput') beforeInputTargets.push(this)
          return add.call(this as EventTarget, type, ...rest)
        } as never
        unregister.push(() => {
          ;(owner as EventTarget).addEventListener = add
        })
        editor = createEditor({
          namespace: 'lexical-solid',
          onError: (error) => {
            throw error
          },
        })
        unregister.push(registerRichText(editor))
        unregister.push(registerHistory(editor, createEmptyHistoryState(), 300))
        unregister.push(editor.registerUpdateListener(({ editorState }) => updates.push(editorState.toJSON())))
        editor.setRootElement(el)
        editor.update(() => {
          const paragraph = $createParagraphNode()
          paragraph.append($createTextNode('Hello Solid'))
          $getRoot().clear().append(paragraph)
        })
      })
      return <div ref={el} testId="editor" contentEditable style={{ display: 'block', width: 400, height: 120 }} />
    }
    root.render(() =>
      createRoot((dispose) => {
        disposeUi = dispose
        return <Editor />
      }),
    )
    await settle()
    await settle()
  })

  afterAll(() => {
    editor?.setRootElement(null)
    for (const cleanup of unregister.reverse()) cleanup()
    disposeUi?.()
    root?.unmount()
  })

  it('1. mounts without an error and paints "Hello Solid"', () => {
    expect(uncaught).toEqual([])
    expect(lexicalText()).toBe('Hello Solid')
    expect(painted()).toContain('Hello Solid')
    expect(element.isContentEditable).toBe(true)
    expect(editor.getRootElement() === element).toBe(true)
    expect(element.querySelectorAll('p').length).toBe(1)
    // Lexical's CAN_USE_BEFORE_INPUT is this expression, evaluated when the module loads.
    expect('getTargetRanges' in new InputEvent('input')).toBe(true)
    expect(CAN_USE_BEFORE_INPUT).toBe(true)
    expect(beforeInputTargets.includes(element)).toBe(true)
  })

  it('9. exposes the DOM the Lexical environment flags read', () => {
    expect(CAN_USE_DOM).toBe(true)
    expect(typeof navigator.userAgent).toBe('string')
    expect(typeof navigator.platform).toBe('string')
  })

  it('2. root.focus() makes the root the active element', async () => {
    element.focus()
    await settle()
    expect(document.activeElement === element).toBe(true)
  })

  it('3. typing "abc" at a caret inside "Hello" reaches Lexical state and paint', async () => {
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    const updatesBefore = updates.length
    selection.setBaseAndExtent(textNode, 5, textNode, 5)
    await settle()
    await press('a b c')
    await settle()
    expect(lexicalText()).toBe('Helloabc Solid')
    expect(painted()).toContain('Helloabc Solid')
    expect(updates.length).toBeGreaterThan(updatesBefore)
    expect(uncaught).toEqual([])
  })

  it('4. Backspace removes one character from Lexical state and paint', async () => {
    await press('Backspace')
    await settle()
    expect(lexicalText()).toBe('Helloab Solid')
    expect(painted()).toContain('Helloab Solid')
  })

  it('5. Enter adds a paragraph', async () => {
    await press('Enter')
    await settle()
    expect(paragraphs().length).toBe(2)
    expect(element.querySelectorAll('p').length).toBe(2)
    const text = painted()
    expect(text).toContain('Helloab')
    expect(text).toContain(' Solid')
  })

  it('6. undo through registerHistory takes the Enter back', async () => {
    expect(paragraphs()).toEqual(['Helloab', ' Solid'])
    root.renderer.simulateKeystrokes('ControlOrMeta+z')
    await settle()
    expect(paragraphs()).toEqual(['Helloab Solid'])
    expect(element.textContent).toBe('Helloab Solid')
    expect(painted()).toContain('Helloab Solid')
    expect(uncaught).toEqual([])
  })

  it('7. a click on the editable puts the caret where it landed: the selection moves there and typing goes there', async () => {
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    // The caret is at the end, so a click that does nothing leaves it there.
    const length = (textNode as Text).data.length
    selection.setBaseAndExtent(textNode, length, textNode, length)
    await settle()
    const first = paragraphs()[0]
    const box = element.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(box.x + 1, box.y + 8)
    root.renderer.nativeSimulateMouseUp(box.x + 1, box.y + 8)
    await settle()
    expect(uncaught).toEqual([])
    expect([selection.anchorNode === textNode, selection.anchorOffset, selection.isCollapsed]).toEqual([true, 0, true])
    expect(document.activeElement === element).toBe(true)
    await press('z')
    await settle()
    expect(paragraphs()[0]).toBe(`z${first}`)
  })

  it('8. editor.update replacing the content paints "Updated"', async () => {
    const updatesBefore = updates.length
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('Updated'))
      $getRoot().clear().append(paragraph)
    })
    await settle()
    expect(lexicalText()).toBe('Updated')
    expect(painted()).toContain('Updated')
    expect(updates.length).toBeGreaterThan(updatesBefore)
  })

  it('10. an input method composes: Lexical gets the committed text once, and the DOM and Lexical agree after every step', async () => {
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 7, textNode, 7)
    await nextTask()
    await settle()
    const id = root.renderer.getFocusedElementId()
    if (id === null) throw new Error('the editable root has no focus')
    const events: string[] = []
    for (const type of ['compositionstart', 'compositionend']) element.addEventListener(type, () => events.push(type))
    const step = (key: string, text: string) => ({ key, action: 'mark' as const, text })
    for (const marked of [step('k', 'k'), step('a', 'か'), step('n', 'かn'), step('a', 'かな')]) {
      root.renderer.simulateComposition(id, [marked])
      await nextTask()
      await settle()
      // Lexical keeps zero-width spaces around the text of a composition.
      expect(element.textContent?.replaceAll('\u200b', '')).toBe(`Updated${marked.text}`)
    }
    root.renderer.simulateComposition(id, [{ key: 'Enter', action: 'commit', text: 'かな' }])
    await nextTask()
    await settle()
    expect(events).toEqual(['compositionstart', 'compositionend'])
    expect(paragraphs()).toEqual(['Updatedかな'])
    expect(element.textContent).toBe('Updatedかな')
    expect(painted()).toContain('Updatedかな')
    await press('!')
    await nextTask()
    await settle()
    expect(paragraphs()).toEqual(['Updatedかな!'])
    expect(uncaught).toEqual([])
  })

  it('11. Option+Backspace deletes a word and Shift+ArrowLeft extends: Lexical and the DOM agree', async () => {
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('one two three'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle()
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 13, textNode, 13)
    await nextTask()
    await settle()
    await press('Alt+Backspace')
    await nextTask()
    await settle()
    expect(paragraphs()).toEqual(['one two '])
    expect(element.textContent).toBe('one two ')
    expect(painted()).toContain('one two ')
    await press('Shift+ArrowLeft Shift+ArrowLeft')
    await nextTask()
    await settle()
    expect(editor.getEditorState().read(() => $getSelection()?.getTextContent())).toBe('o ')
    expect(selection.toString()).toBe('o ')
    expect(uncaught).toEqual([])
  })

  it('12. a click into the middle of a word puts the caret there: Lexical\'s selection is at the offset and typing lands in it', async () => {
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('one two three'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle()
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    // Where the caret is painted at offset 5, between `t` and `wo`; a click a pixel to its right is nearest to it.
    const range = document.createRange()
    range.setStart(textNode, 5)
    range.collapse(true)
    const at = range.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(at.x + 1, at.y + at.height / 2)
    root.renderer.nativeSimulateMouseUp(at.x + 1, at.y + at.height / 2)
    await settle()
    expect(editor.getEditorState().read(() => {
      const selection = $getSelection()
      return $isRangeSelection(selection) ? [selection.anchor.offset, selection.focus.offset, selection.isCollapsed()] : null
    })).toEqual([5, 5, true])
    await press('X')
    await settle()
    expect(paragraphs()).toEqual(['one tXwo three'])
    expect(element.textContent).toBe('one tXwo three')
    expect(painted()).toContain('one tXwo three')
    expect(uncaught).toEqual([])
  })

  it('13. a click on an empty paragraph puts the caret in it: Lexical\'s selection is that paragraph and typing lands in it', async () => {
    editor.update(() => {
      const paragraph = (text: string) => {
        const node = $createParagraphNode()
        if (text !== '') node.append($createTextNode(text))
        return node
      }
      $getRoot().clear().append(paragraph('one'), paragraph(''), paragraph('three'))
    })
    await nextTask()
    await settle()
    const empty = element.querySelectorAll('p')[1]
    if (empty === undefined) throw new Error('no second paragraph')
    expect(empty.textContent).toBe('')
    const at = empty.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(at.x + 4, at.y + at.height / 2)
    root.renderer.nativeSimulateMouseUp(at.x + 4, at.y + at.height / 2)
    await nextTask()
    await settle()
    expect(editor.getEditorState().read(() => {
      const selection = $getSelection()
      return $isRangeSelection(selection) ? [selection.anchor.getNode().getKey() === $getRoot().getChildAtIndex(1)?.getKey(), selection.isCollapsed()] : null
    })).toEqual([true, true])
    await press('X')
    await nextTask()
    await settle()
    expect(paragraphs()).toEqual(['one', 'X', 'three'])
    expect(element.querySelectorAll('p')[1]?.textContent).toBe('X')
    expect(painted()).toContain('X')
    expect(uncaught).toEqual([])
  })

  it('14. ArrowDown and ArrowUp stop in empty paragraphs, a trailing one included: Lexical\'s selection is that paragraph and typing lands in it', async () => {
    editor.update(() => {
      const paragraph = (text: string) => {
        const node = $createParagraphNode()
        if (text !== '') node.append($createTextNode(text))
        return node
      }
      $getRoot().clear().append(paragraph('one two'), paragraph(''), paragraph('three four'), paragraph(''))
    })
    await nextTask()
    await settle()
    const first = element.querySelector('span')?.firstChild
    if (first === null || first === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(first, 4, first, 4)
    await nextTask()
    await settle()
    const paragraphIndex = (): number | null =>
      editor.getEditorState().read(() => {
        const lexical = $getSelection()
        if (!$isRangeSelection(lexical) || !lexical.isCollapsed()) return null
        return $getRoot().getChildren().findIndex((child) => child.getKey() === lexical.anchor.getNode().getTopLevelElementOrThrow().getKey())
      })
    const visit = async (keys: string, expected: number): Promise<void> => {
      await press(keys)
      await nextTask()
      await settle()
      expect(paragraphIndex()).toBe(expected)
    }
    await visit('ArrowDown', 1)
    expect(editor.getEditorState().read(() => ($getSelection() as { anchor: { offset: number } }).anchor.offset)).toBe(0)
    await visit('ArrowDown', 2)
    await visit('ArrowDown', 3)
    await visit('ArrowDown', 3)
    await visit('ArrowUp', 2)
    await visit('ArrowUp', 1)
    await visit('ArrowUp', 0)
    await visit('ArrowDown', 1)
    await press('X')
    await nextTask()
    await settle()
    expect(paragraphs()).toEqual(['one two', 'X', 'three four', ''])
    expect(uncaught).toEqual([])
  })

  it('15. keys that AppKit queues before one tick each get their own microtask checkpoint: Lexical commits every one', async () => {
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('Hello'))
      $getRoot().clear().append(paragraph)
    })
    await nextTask()
    await settle()
    const first = element.querySelector('span')?.firstChild
    if (first === null || first === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(first, 5, first, 5)
    await nextTask()
    await settle()
    // Three letters, each a keyDown and a keyUp, are in AppKit's queue before the first pump, as when a slow frame
    // or key repeat leaves several waiting. A pump sends one key event and the loop turns before the next.
    root.renderer.postNativeKeys('abc')
    // A keyDown and a keyUp for each of the three letters, and one pump more.
    for (let pump = 0; pump < 7; pump++) {
      root.renderer.pumpNativeEvents()
      await nextTask()
    }
    await settle()
    expect(lexicalText()).toBe('Helloabc')
    expect(paragraphs()).toEqual(['Helloabc'])
    expect(element.textContent).toBe('Helloabc')
    expect(painted()).toContain('Helloabc')
    expect(uncaught).toEqual([])
  })
})

// Two editors in one window, and the clipboard between them. Keys go through the real path (AppKit's key equivalent,
// the GPUI action, the page's copy, cut and paste events); the test renderer keeps its own clipboard, never the system one.

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

describeNative('vanilla Lexical in @ghia/solid: clipboard between two editors on Ghia', () => {
  const uncaught: unknown[] = []
  const pair: LexicalEditor[] = []
  const unregister: Array<() => void> = []
  let window: ReturnType<typeof createTestRoot>
  let disposeUi: () => void

  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const settle = async (): Promise<void> => {
    await nextTask()
    window.renderer.dispatchNativeEvents()
    window.renderer.advanceTime(10)
    window.renderer.drawFrame()
    window.renderer.flush()
  }
  const idle = async (): Promise<void> => {
    await settle()
    await settle()
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
    function Pane(props: { index: number }) {
      let el!: HTMLDivElement
      onMount(() => {
        const created = createEditor({
          namespace: `lexical-clipboard-${props.index}`,
          onError: (error) => {
            throw error
          },
        })
        unregister.push(registerRichText(created))
        created.setRootElement(el)
        created.update(() => {
          $getRoot().clear().append($createParagraphNode())
        })
        pair[props.index] = created
      })
      return <div ref={el} contentEditable style={{ display: 'block', width: 300, minHeight: 40 }} />
    }
    window.render(() =>
      createRoot((dispose) => {
        disposeUi = dispose
        return (
          <div>
            <Pane index={0} />
            <Pane index={1} />
          </div>
        )
      }),
    )
    await idle()
  })

  afterAll(() => {
    for (const target of pair) target.setRootElement(null)
    for (const cleanup of unregister.reverse()) cleanup()
    disposeUi?.()
    window?.unmount()
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
describeNative('vanilla Lexical lists in @ghia/solid on Ghia', () => {
  let window: ReturnType<typeof createTestRoot>
  let disposeUi: () => void
  let target: LexicalEditor
  let element: HTMLElement
  const uncaught: unknown[] = []
  const unregister: Array<() => void> = []
  const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
  const settle = async (): Promise<void> => {
    await nextTask()
    window.renderer.dispatchNativeEvents()
    window.renderer.advanceTime(10)
    window.renderer.drawFrame()
    window.renderer.flush()
  }
  const idle = async (): Promise<void> => {
    await settle()
    await settle()
  }

  beforeAll(async () => {
    window = createTestRoot({ width: 480, height: 320, onUncaughtError: (error: unknown) => uncaught.push(error) })
    function Editor() {
      let el!: HTMLDivElement
      onMount(() => {
        element = el
        target = createEditor({
          namespace: 'lexical-solid-lists',
          nodes: [ListNode, ListItemNode],
          onError: (error) => {
            throw error
          },
        })
        unregister.push(registerRichText(target))
        unregister.push(registerList(target))
        target.setRootElement(el)
        target.update(() => {
          $getRoot()
            .clear()
            .append(...['first', 'second', 'third'].map((text) => $createParagraphNode().append($createTextNode(text))))
        })
      })
      return <div ref={el} contentEditable style={{ display: 'block', width: 400, 'min-height': 40, 'background-color': '#ffffff', color: '#000000' }} />
    }
    window.render(() =>
      createRoot((dispose) => {
        disposeUi = dispose
        return <Editor />
      }),
    )
    await idle()
  })

  afterAll(() => {
    target?.setRootElement(null)
    for (const cleanup of unregister.reverse()) cleanup()
    disposeUi?.()
    window?.unmount()
  })

  const items = (): HTMLElement[] => [...element.querySelectorAll('li')] as HTMLElement[]
  const markers = (name: string): { ink: number[]; shapes: string[] } => {
    const file = `${import.meta.dirname}/screens/lists-solid-${name}.png`
    window.renderer.captureScreenshot(file)
    const shot = readScreenshot(file)
    const scale = shot.width / window.renderer.getWindowSize().width
    const boxes = items().map((item) => item.getBoundingClientRect())
    return { ink: boxes.map((box) => markerInk(shot, scale, box)), shapes: boxes.map((box) => markerPixels(shot, scale, box)) }
  }

  it('paints no marker for a paragraph, a bullet for each item of an unordered list and its number for each of an ordered one', async () => {
    expect(items().length).toBe(0)
    target.update(() => $selectAll())
    await idle()
    target.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
    await idle()
    expect(items().length).toBe(3)
    const bulleted = markers('bulleted')
    expect(bulleted.ink.every((ink) => ink > 0), `a bullet in front of every item: ${bulleted.ink}`).toBe(true)
    expect(new Set(bulleted.shapes).size, 'every bullet is the same').toBe(1)

    target.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
    await idle()
    expect(items().length).toBe(3)
    const numbered = markers('numbered')
    expect(numbered.ink.every((ink) => ink > 0), `a number in front of every item: ${numbered.ink}`).toBe(true)
    expect(new Set(numbered.shapes).size, 'every number is another').toBe(3)
    expect(numbered.shapes).not.toEqual(bulleted.shapes)
    expect(uncaught).toEqual([])
  })
})
