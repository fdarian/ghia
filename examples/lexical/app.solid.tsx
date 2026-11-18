import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { $toggleLink, TOGGLE_LINK_COMMAND } from '@lexical/link'
import { registerList } from '@lexical/list'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { registerRichText } from '@lexical/rich-text'
import { mergeRegister } from '@lexical/utils'
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  createEditor,
  HISTORY_MERGE_TAG,
  REDO_COMMAND,
  UNDO_COMMAND,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical'
import css from './editor.css?raw'
import { $seed, nodes, theme } from './editor-config'
import { hideFloating, positionFloating, selectionRect } from './floating'
import { $readFormat, formatText, setBlock, setLink, toggleList, type BlockType, type FormatState } from './format'
import { icons, type IconName } from './icons'

function Icon(props: { name: IconName }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <For each={icons[props.name]}>{(d) => <path d={d} />}</For>
    </svg>
  )
}

function ToolbarButton(props: {
  icon?: IconName
  label: string
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children?: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      class="tb-btn"
      classList={{ active: props.active }}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.title}
      disabled={props.disabled}
      // Pressing a button must not take the selection away from the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => props.onClick()}
      testId={props.label}
    >
      <Show when={props.icon}>{(name) => <Icon name={name()} />}</Show>
      {props.children}
    </button>
  )
}

const TEXT_FORMATS: Array<{ format: TextFormatType & keyof FormatState; icon: IconName; label: string; title: string }> = [
  { format: 'bold', icon: 'bold', label: 'Bold', title: 'Bold (⌘B)' },
  { format: 'italic', icon: 'italic', label: 'Italic', title: 'Italic (⌘I)' },
  { format: 'underline', icon: 'underline', label: 'Underline', title: 'Underline (⌘U)' },
  { format: 'strikethrough', icon: 'strikethrough', label: 'Strikethrough', title: 'Strikethrough' },
  { format: 'code', icon: 'code', label: 'Code', title: 'Inline code' },
]

/** `registerLink` of @lexical/link needs its extension's signals; the vanilla API registers the command itself. */
function registerLinkCommand(editor: LexicalEditor): () => void {
  return editor.registerCommand(
    TOGGLE_LINK_COMMAND,
    (payload) => {
      if (typeof payload === 'object' && payload !== null) $toggleLink(payload.url, payload)
      else $toggleLink(payload)
      return true
    },
    COMMAND_PRIORITY_LOW,
  )
}

export function EditorApp(): JSX.Element {
  const editor = createEditor({
    namespace: 'lexical-solid-app',
    nodes,
    theme,
    onError: (error) => {
      throw error
    },
  })

  let app!: HTMLDivElement
  let scroller!: HTMLDivElement
  let input!: HTMLDivElement
  let floating: HTMLDivElement | undefined
  let linkInput: HTMLInputElement | undefined
  let pointerDown = false

  const [format, setFormat] = createSignal<FormatState | null>(null)
  const [floatingFormat, setFloatingFormat] = createSignal<FormatState | null>(null)
  const [canUndo, setCanUndo] = createSignal(false)
  const [canRedo, setCanRedo] = createSignal(false)
  const [empty, setEmpty] = createSignal(false)
  const [linkOpen, setLinkOpen] = createSignal(false)
  const [url, setUrl] = createSignal('https://')

  const block = (): BlockType => {
    const current = format()
    return current === null ? 'paragraph' : current.block
  }

  const updateFloating = (): void => {
    if (pointerDown) return setFloatingFormat(null)
    const next = editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed() || selection.getTextContent() === '') return null
      return $readFormat()
    })
    setFloatingFormat(next !== null && selectionRect(input) !== null ? next : null)
  }

  const place = (): void => {
    if (floating === undefined || !floating.isConnected) return
    const rect = selectionRect(input)
    if (rect === null) hideFloating(floating)
    else positionFloating(rect, floating, scroller)
  }

  createEffect(() => {
    floatingFormat()
    place()
  })

  const closeLinkBar = (): void => {
    setLinkOpen(false)
    editor.focus()
  }

  const applyLink = (): void => {
    setLink(editor, url())
    closeLinkBar()
  }

  const toggleLinkFor = (current: FormatState | null): void => {
    if (current !== null && current.link) setLink(editor, null)
    else setLinkOpen(true)
  }

  createEffect(() => {
    if (linkOpen()) linkInput?.focus()
  })

  onMount(() => {
    editor.setRootElement(input)
    const press = (): void => {
      pointerDown = true
      setFloatingFormat(null)
    }
    const release = (): void => {
      pointerDown = false
      updateFloating()
    }
    input.addEventListener('pointerdown', press)
    document.addEventListener('pointerup', release)
    document.addEventListener('selectionchange', updateFloating)
    scroller.addEventListener('scroll', place)
    window.addEventListener('resize', place)

    const unregister = mergeRegister(
      registerRichText(editor),
      registerHistory(editor, createEmptyHistoryState(), 300),
      registerList(editor),
      registerLinkCommand(editor),
      editor.registerUpdateListener((update) => {
        update.editorState.read(() => {
          const next = $readFormat()
          if (next !== null) setFormat(next)
          const root = $getRoot()
          const first = root.getFirstChild()
          setEmpty(root.getChildrenSize() === 0 || (root.getChildrenSize() === 1 && first !== null && first.isEmpty()))
        })
        updateFloating()
      }),
      editor.registerCommand(CAN_UNDO_COMMAND, (payload) => (setCanUndo(payload), false), COMMAND_PRIORITY_LOW),
      editor.registerCommand(CAN_REDO_COMMAND, (payload) => (setCanRedo(payload), false), COMMAND_PRIORITY_LOW),
    )
    editor.update(
      () => {
        $getRoot().clear()
        $seed()
      },
      { tag: HISTORY_MERGE_TAG },
    )
    editor.focus()

    onCleanup(() => {
      unregister()
      editor.setRootElement(null)
      input.removeEventListener('pointerdown', press)
      document.removeEventListener('pointerup', release)
      document.removeEventListener('selectionchange', updateFloating)
      scroller.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
    })
  })

  return (
    <div class="app" ref={app}>
      <style>{css}</style>
      <div class="app-header">
        <h1 class="app-title">Lexical on Ghia</h1>
        <span class="app-subtitle">Solid · vanilla Lexical</span>
      </div>
      <div class="shell">
        <div class="toolbar" role="toolbar" aria-label="Formatting">
          <ToolbarButton icon="undo" label="Undo" title="Undo (⌘Z)" disabled={!canUndo()} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} />
          <ToolbarButton icon="redo" label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo()} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} />
          <div class="tb-sep" />
          <For each={TEXT_FORMATS}>
            {(entry) => (
              <ToolbarButton
                icon={entry.icon}
                label={entry.label}
                title={entry.title}
                active={format() !== null && format()![entry.format]}
                onClick={() => formatText(editor, entry.format)}
              />
            )}
          </For>
          <div class="tb-sep" />
          <ToolbarButton label="Heading 1" title="Heading 1" active={block() === 'h1'} onClick={() => setBlock(editor, 'h1', block())}>
            H1
          </ToolbarButton>
          <ToolbarButton label="Heading 2" title="Heading 2" active={block() === 'h2'} onClick={() => setBlock(editor, 'h2', block())}>
            H2
          </ToolbarButton>
          <ToolbarButton label="Paragraph" title="Paragraph" active={block() === 'paragraph'} onClick={() => setBlock(editor, 'paragraph', block())}>
            ¶
          </ToolbarButton>
          <ToolbarButton icon="quote" label="Quote" title="Quote" active={block() === 'quote'} onClick={() => setBlock(editor, 'quote', block())} />
          <div class="tb-sep" />
          <ToolbarButton icon="list" label="Bulleted list" title="Bulleted list" active={block() === 'bullet'} onClick={() => toggleList(editor, 'bullet', block())} />
          <ToolbarButton icon="listOrdered" label="Numbered list" title="Numbered list" active={block() === 'number'} onClick={() => toggleList(editor, 'number', block())} />
          <div class="tb-sep" />
          <ToolbarButton icon="link" label="Link" title="Link" active={format() !== null && format()!.link} onClick={() => toggleLinkFor(format())} />
        </div>
        <Show when={linkOpen()}>
          <form
            class="link-bar"
            onSubmit={(event) => {
              event.preventDefault()
              applyLink()
            }}
          >
            <input
              ref={linkInput}
              class="link-input"
              testId="link-url"
              type="url"
              value={url()}
              spellcheck={false}
              aria-label="Link URL"
              onInput={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') closeLinkBar()
              }}
            />
            <button type="submit" class="link-apply" testId="link-apply">
              Apply
            </button>
            <button type="button" class="link-cancel" onClick={closeLinkBar}>
              Cancel
            </button>
          </form>
        </Show>
        <div class="scroller" ref={scroller} testId="scroller">
          <div class="editor-inner">
            <div ref={input} class="editor-input" contentEditable spellcheck={false} role="textbox" aria-label="Document" testId="editor" />
            <Show when={empty()}>
              <div class="placeholder">Write something…</div>
            </Show>
          </div>
        </div>
      </div>
      <Show when={floatingFormat()}>
        {(current) => (
          <div
            ref={(element) => {
              floating = element
              onCleanup(() => {
                floating = undefined
              })
            }}
            class="floating"
            role="toolbar"
            aria-label="Text formatting"
            testId="floating-toolbar"
          >
            <For each={TEXT_FORMATS}>
              {(entry) => (
                <ToolbarButton
                  icon={entry.icon}
                  label={`Floating ${entry.label}`}
                  title={entry.title}
                  active={current()[entry.format]}
                  onClick={() => formatText(editor, entry.format)}
                />
              )}
            </For>
            <ToolbarButton icon="link" label="Floating Link" title="Link" active={current().link} onClick={() => toggleLinkFor(current())} />
          </div>
        )}
      </Show>
    </div>
  )
}
