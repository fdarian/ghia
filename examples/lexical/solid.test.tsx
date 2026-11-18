import { createRoot, onMount } from 'solid-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  createEditor,
  type LexicalEditor,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/solid/testing'

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

  it('7. a click on the editable is harmless: the selection stays where it was put and typing goes there', async () => {
    // Put the caret at the start explicitly, so nothing depends on where an earlier step left it.
    const textNode = element.querySelector('span')?.firstChild
    if (textNode === null || textNode === undefined) throw new Error('no text node under the editable root')
    const selection = getSelection()
    if (selection === null) throw new Error('getSelection() returned null')
    selection.setBaseAndExtent(textNode, 0, textNode, 0)
    await settle()
    const first = paragraphs()[0]
    const box = element.getBoundingClientRect()
    root.renderer.nativeSimulateMouseDown(box.x + 10, box.y + 8)
    root.renderer.nativeSimulateMouseUp(box.x + 10, box.y + 8)
    await settle()
    expect(uncaught).toEqual([])
    // A click in an editing host does not move the node selection yet (deviations.md), so it still sits at the start.
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
})
