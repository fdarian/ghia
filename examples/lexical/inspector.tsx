import { useLayoutEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { createEmptyHistoryState } from '@lexical/history'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type EditorState,
} from 'lexical'

export const FIRST_PARAGRAPH = 'The quick brown fox jumps over the lazy dog.'
export const LONG_PARAGRAPH =
  'Lexical is an extensible text editor framework that provides excellent reliability, accessibility and performance. ' +
  'This paragraph is deliberately long so that it wraps over several lines inside the panel, which is where caret placement, ' +
  'selection washes that span line boxes and word-wise deletion are most likely to go wrong.'
export const LAST_PARAGRAPH = 'A short closing line.'

function seed(): void {
  const root = $getRoot()
  for (const text of [FIRST_PARAGRAPH, '', LONG_PARAGRAPH, LAST_PARAGRAPH]) {
    const paragraph = $createParagraphNode()
    if (text !== '') paragraph.append($createTextNode(text))
    root.append(paragraph)
  }
}

function describeSelection(state: EditorState, undoDepth: number): string {
  return state.read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return `selection: none\nundo depth: ${undoDepth}`
    const text = selection.getTextContent().replace(/\n/g, '\\n')
    return `selection: ${selection.anchor.key}:${selection.anchor.offset} -> ${selection.focus.key}:${selection.focus.offset} ${JSON.stringify(text)}\nundo depth: ${undoDepth}`
  })
}

const palette = {
  ink: '#1d1d1f',
  muted: '#6e6e73',
  line: '#d2d2d7',
  paper: '#ffffff',
  wash: '#f5f5f7',
}

const styles = {
  window: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    background: palette.wash,
    color: palette.ink,
    // One installed family, not a stack: a font stack falls through to the bundled sans face, which has no bold
    // weight, and that would hide what the Bold button does.
    fontFamily: 'Helvetica Neue',
    fontSize: 15,
  },
  body: { display: 'flex', flex: 1, minHeight: 0, gap: 16, padding: 16 },
  editorColumn: { display: 'flex', flexDirection: 'column', width: 520, flexShrink: 0 },
  toolbar: { display: 'flex', gap: 8, paddingBottom: 8 },
  button: {
    padding: '4px 12px',
    border: `1px solid ${palette.line}`,
    borderRadius: 6,
    background: palette.paper,
    fontWeight: 700,
  },
  panel: {
    height: 280,
    overflow: 'auto',
    border: `1px solid ${palette.line}`,
    borderRadius: 8,
    background: palette.paper,
  },
  editable: {
    minHeight: 278,
    padding: '16px 20px',
    outline: 'none',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
  stateColumn: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 },
  heading: { color: palette.muted, fontSize: 12, paddingBottom: 6 },
  state: {
    flex: 1,
    margin: 0,
    padding: 12,
    overflow: 'auto',
    border: `1px solid ${palette.line}`,
    borderRadius: 8,
    background: palette.paper,
    fontFamily: 'Menlo, monospace',
    fontSize: 11,
    lineHeight: 1.4,
  },
  selection: {
    margin: 0,
    paddingTop: 8,
    overflow: 'hidden',
    color: palette.muted,
    fontFamily: 'Menlo, monospace',
    fontSize: 11,
    whiteSpace: 'pre',
    textOverflow: 'ellipsis',
  },
} satisfies Record<string, CSSProperties>

function BoldButton(): ReactNode {
  const [editor] = useLexicalComposerContext()
  return (
    <div
      testId="bold"
      style={styles.button}
      // A press on a toolbar button must not take the selection away from the editor.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
    >
      B
    </div>
  )
}

/** Reports the seeded state too, which `OnChangePlugin` skips because the seed is applied before it mounts. */
function StatePlugin(props: { onState: (state: EditorState) => void }): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    props.onState(editor.getEditorState())
    return editor.registerUpdateListener((update) => props.onState(update.editorState))
  }, [editor, props.onState])
  return null
}

export function EditorApp(): ReactNode {
  const [json, setJson] = useState('')
  const [selection, setSelection] = useState('')
  const [history] = useState(createEmptyHistoryState)

  return (
    <div style={styles.window}>
      <div style={styles.body}>
        <LexicalComposer
          initialConfig={{
            namespace: 'lexical-editor-example',
            onError: (error: Error) => {
              throw error
            },
            editorState: seed,
            theme: { text: { bold: 'bold' } },
          }}
        >
          <div style={styles.editorColumn}>
            <div style={styles.toolbar}>
              <BoldButton />
            </div>
            <div style={styles.panel} testId="panel">
              <RichTextPlugin
                contentEditable={<ContentEditable style={styles.editable} />}
                ErrorBoundary={LexicalErrorBoundary}
              />
            </div>
            <pre style={styles.selection} testId="selection">
              {selection}
            </pre>
          </div>
          <HistoryPlugin externalHistoryState={history} />
          <StatePlugin
            onState={(state) => {
              setJson(JSON.stringify(state.toJSON(), null, 1))
              setSelection(describeSelection(state, history.undoStack.length))
            }}
          />
          <div style={styles.stateColumn}>
            <div style={styles.heading}>EDITOR STATE</div>
            <pre style={styles.state} testId="state">
              {json}
            </pre>
          </div>
        </LexicalComposer>
      </div>
    </div>
  )
}
