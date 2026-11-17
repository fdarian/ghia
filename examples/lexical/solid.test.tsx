import { createRoot, onMount } from 'solid-js'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  CAN_USE_BEFORE_INPUT,
  CAN_USE_DOM,
  createEditor,
  IS_ANDROID,
  IS_APPLE,
  IS_CHROME,
  IS_FIREFOX,
  IS_IOS,
  IS_SAFARI,
  type LexicalEditor,
} from 'lexical'
import { registerRichText } from '@lexical/rich-text'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { createTestRoot, hasNativeTestRenderer } from '@ghia/solid/testing'

// Vanilla Lexical (createEditor, registerRichText, registerHistory, setRootElement) inside a @ghia/solid component,
// running unchanged on Ghia's contenteditable support. `solid-report.json` records what the run observed; the
// assertions are the test. The editor lives across the steps, so this file mounts its own root instead of using
// `../solid-harness`, whose `mount` is unmounted after every test.

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
  const snapshot = (): Json => ({ lexical: paragraphs(), painted: root.renderer.getPaintedText(), dom: element.textContent })

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
    writeFileSync(new URL('./solid-report.json', import.meta.url), JSON.stringify(report, null, 2))
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
    note('1.mount', {
      painted: root.renderer.getPaintedText(),
      lexicalText: lexicalText(),
      CAN_USE_BEFORE_INPUT,
      beforeInputListenerOnRoot: beforeInputTargets.includes(element),
      rootAttributes: Object.fromEntries(element.getAttributeNames().map((name) => [name, element.getAttribute(name)])),
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
    note('3.selectionAfterSet', { anchorOffset: selection.anchorOffset, anchorIsText: selection.anchorNode === textNode, type: selection.type })
    await press('a b c')
    await settle()
    note('3.type-abc', { ...snapshot(), updateListenerCalls: updates.length - updatesBefore })
    expect(lexicalText()).toBe('Helloabc Solid')
    expect(painted()).toContain('Helloabc Solid')
    expect(updates.length).toBeGreaterThan(updatesBefore)
    expect(uncaught).toEqual([])
  })

  it('4. Backspace removes one character from Lexical state and paint', async () => {
    await press('Backspace')
    await settle()
    note('4.backspace', snapshot())
    expect(lexicalText()).toBe('Helloab Solid')
    expect(painted()).toContain('Helloab Solid')
  })

  it('5. Enter adds a paragraph', async () => {
    await press('Enter')
    await settle()
    note('5.enter', { ...snapshot(), paragraphElements: element.querySelectorAll('p').length })
    expect(paragraphs().length).toBe(2)
    expect(element.querySelectorAll('p').length).toBe(2)
    const text = painted()
    expect(text).toContain('Helloab')
    expect(text).toContain(' Solid')
  })

  it('6. undo through registerHistory (recorded, not required)', async () => {
    const before = snapshot()
    let error: unknown
    try {
      root.renderer.simulateKeystrokes('ControlOrMeta+z')
      await settle()
    } catch (thrown) {
      error = thrown
    }
    note('6.undo', { before, after: snapshot(), threw: error === undefined ? null : errorText(error) })
    expect(error).toBeUndefined()
  })

  it('7. a click on the editable does not throw and the editor still updates', async () => {
    const box = element.getBoundingClientRect()
    let error: unknown
    try {
      root.renderer.nativeSimulateMouseDown(box.x + 10, box.y + 8)
      root.renderer.nativeSimulateMouseUp(box.x + 10, box.y + 8)
      await settle()
    } catch (thrown) {
      error = thrown
    }
    expect(error).toBeUndefined()
    expect(uncaught).toEqual([])
    const before = lexicalText()
    await press('z')
    await settle()
    note('7.click', { threw: error === undefined ? null : errorText(error), before, after: snapshot(), activeIsRoot: document.activeElement === element })
    expect(lexicalText()).not.toBe(before)
    expect(lexicalText()).toContain('z')
  })

  it('8. editor.update replacing the content paints "Updated"', async () => {
    const updatesBefore = updates.length
    editor.update(() => {
      const paragraph = $createParagraphNode()
      paragraph.append($createTextNode('Updated'))
      $getRoot().clear().append(paragraph)
    })
    await settle()
    note('8.update', { ...snapshot(), updateListenerCalls: updates.length - updatesBefore })
    expect(lexicalText()).toBe('Updated')
    expect(painted()).toContain('Updated')
    expect(updates.length).toBeGreaterThan(updatesBefore)
  })
})
