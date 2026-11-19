import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin'
import { mergeRegister } from '@lexical/utils'
import {
  $getSelection,
  $isRangeSelection,
  CAN_REDO_COMMAND,
  CAN_UNDO_COMMAND,
  COMMAND_PRIORITY_LOW,
  REDO_COMMAND,
  UNDO_COMMAND,
  type TextFormatType,
} from 'lexical'
import css from './editor.css?raw'
import { $seed, nodes, theme } from './editor-config'
import { hideFloating, positionFloating, selectionRect } from './floating'
import { $readFormat, formatText, setBlock, setLink, toggleList, type BlockType, type FormatState } from './format'
import { icons, type IconName } from './icons'

function Icon(props: { name: IconName }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {icons[props.name].map((d) => (
        <path key={d} d={d} />
      ))}
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
  children?: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      className={props.active ? 'tb-btn active' : 'tb-btn'}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.title}
      disabled={props.disabled}
      // Pressing a button must not take the selection away from the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
      testId={props.label}
    >
      {props.icon === undefined ? null : <Icon name={props.icon} />}
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

function Toolbar(props: { openLinkBar: () => void }): ReactNode {
  const [editor] = useLexicalComposerContext()
  const [format, setFormat] = useState<FormatState | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener((update) => {
          update.editorState.read(() => {
            const next = $readFormat()
            if (next !== null) setFormat(next)
          })
        }),
        editor.registerCommand(
          CAN_UNDO_COMMAND,
          (payload) => {
            setCanUndo(payload)
            return false
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          CAN_REDO_COMMAND,
          (payload) => {
            setCanRedo(payload)
            return false
          },
          COMMAND_PRIORITY_LOW,
        ),
      ),
    [editor],
  )

  const block: BlockType = format === null ? 'paragraph' : format.block
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <ToolbarButton icon="undo" label="Undo" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)} />
      <ToolbarButton icon="redo" label="Redo" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)} />
      <div className="tb-sep" />
      {TEXT_FORMATS.map((entry) => (
        <ToolbarButton
          key={entry.format}
          icon={entry.icon}
          label={entry.label}
          title={entry.title}
          active={format !== null && format[entry.format]}
          onClick={() => formatText(editor, entry.format)}
        />
      ))}
      <div className="tb-sep" />
      <ToolbarButton label="Heading 1" title="Heading 1" active={block === 'h1'} onClick={() => setBlock(editor, 'h1', block)}>
        H1
      </ToolbarButton>
      <ToolbarButton label="Heading 2" title="Heading 2" active={block === 'h2'} onClick={() => setBlock(editor, 'h2', block)}>
        H2
      </ToolbarButton>
      <ToolbarButton label="Paragraph" title="Paragraph" active={block === 'paragraph'} onClick={() => setBlock(editor, 'paragraph', block)}>
        ¶
      </ToolbarButton>
      <ToolbarButton icon="quote" label="Quote" title="Quote" active={block === 'quote'} onClick={() => setBlock(editor, 'quote', block)} />
      <div className="tb-sep" />
      <ToolbarButton icon="list" label="Bulleted list" title="Bulleted list" active={block === 'bullet'} onClick={() => toggleList(editor, 'bullet', block)} />
      <ToolbarButton icon="listOrdered" label="Numbered list" title="Numbered list" active={block === 'number'} onClick={() => toggleList(editor, 'number', block)} />
      <div className="tb-sep" />
      <ToolbarButton icon="link" label="Link" title="Link" active={format !== null && format.link} onClick={() => (format !== null && format.link ? setLink(editor, null) : props.openLinkBar())} />
    </div>
  )
}

function LinkBar(props: { onClose: () => void }): ReactNode {
  const [editor] = useLexicalComposerContext()
  const [url, setUrl] = useState('https://')

  const apply = (): void => {
    setLink(editor, url)
    props.onClose()
    editor.focus()
  }
  const cancel = (): void => {
    props.onClose()
    editor.focus()
  }

  return (
    <form
      className="link-bar"
      onSubmit={(event) => {
        event.preventDefault()
        apply()
      }}
    >
      <input
        className="link-input"
        testId="link-url"
        type="url"
        value={url}
        autoFocus
        spellCheck={false}
        aria-label="Link URL"
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') cancel()
        }}
      />
      <button type="submit" className="link-apply" testId="link-apply">
        Apply
      </button>
      <button type="button" className="link-cancel" onClick={cancel}>
        Cancel
      </button>
    </form>
  )
}

/** Shown over a selection that is not a caret, positioned from the selection's range like the Lexical playground's. */
function FloatingToolbar(props: { scroller: RefObject<HTMLDivElement | null>; openLinkBar: () => void }): ReactNode {
  const [editor] = useLexicalComposerContext()
  const [format, setFormat] = useState<FormatState | null>(null)
  const floating = useRef<HTMLDivElement>(null)
  const pointerDown = useRef(false)

  const update = useCallback(() => {
    const root = editor.getRootElement()
    if (root === null || pointerDown.current) return setFormat(null)
    const next = editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.isCollapsed() || selection.getTextContent() === '') return null
      return $readFormat()
    })
    setFormat(next !== null && selectionRect(root) !== null ? next : null)
  }, [editor])

  const place = useCallback(() => {
    const root = editor.getRootElement()
    const scroller = props.scroller.current
    if (floating.current === null || root === null || scroller === null) return
    const rect = selectionRect(root)
    if (rect === null) hideFloating(floating.current)
    else positionFloating(rect, floating.current, scroller)
  }, [editor, props.scroller])

  useEffect(() => {
    const root = editor.getRootElement()
    const scroller = props.scroller.current
    if (root === null || scroller === null) throw new Error('the editor has no root element')
    const press = (): void => {
      pointerDown.current = true
      setFormat(null)
    }
    const release = (): void => {
      pointerDown.current = false
      update()
    }
    root.addEventListener('pointerdown', press)
    document.addEventListener('pointerup', release)
    document.addEventListener('selectionchange', update)
    scroller.addEventListener('scroll', place)
    window.addEventListener('resize', place)
    const unregister = editor.registerUpdateListener(update)
    return () => {
      root.removeEventListener('pointerdown', press)
      document.removeEventListener('pointerup', release)
      document.removeEventListener('selectionchange', update)
      scroller.removeEventListener('scroll', place)
      window.removeEventListener('resize', place)
      unregister()
    }
  }, [editor, props.scroller, update, place])

  useLayoutEffect(place, [format, place])

  if (format === null) return null
  return (
    <div ref={floating} className="floating" role="toolbar" aria-label="Text formatting" testId="floating-toolbar">
      {TEXT_FORMATS.map((entry) => (
        <ToolbarButton
          key={entry.format}
          icon={entry.icon}
          label={`Floating ${entry.label}`}
          title={entry.title}
          active={format[entry.format]}
          onClick={() => formatText(editor, entry.format)}
        />
      ))}
      <ToolbarButton icon="link" label="Floating Link" title="Link" active={format.link} onClick={() => (format !== null && format.link ? setLink(editor, null) : props.openLinkBar())} />
    </div>
  )
}

export function EditorApp(): ReactNode {
  const [linkOpen, setLinkOpen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  return (
    <div className="app">
      <style>{css}</style>
      <div className="app-header">
        <h1 className="app-title">Lexical on Ghia</h1>
        <span className="app-subtitle">React · @lexical/react</span>
      </div>
      <LexicalComposer
        initialConfig={{
          namespace: 'lexical-react-app',
          nodes,
          theme,
          editorState: $seed,
          onError: (error: Error) => {
            throw error
          },
        }}
      >
        <div className="shell">
          <Toolbar openLinkBar={() => setLinkOpen(true)} />
          {linkOpen ? <LinkBar onClose={() => setLinkOpen(false)} /> : null}
          <div className="scroller" ref={scroller} testId="scroller">
            <div className="editor-inner">
              <RichTextPlugin
                contentEditable={<ContentEditable className="editor-input" aria-label="Document" testId="editor" />}
                placeholder={<div className="placeholder">Write something…</div>}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </div>
          </div>
        </div>
        <HistoryPlugin />
        <ListPlugin />
        <LinkPlugin />
        <AutoFocusPlugin />
        <FloatingToolbar scroller={scroller} openLinkBar={() => setLinkOpen(true)} />
      </LexicalComposer>
    </div>
  )
}
