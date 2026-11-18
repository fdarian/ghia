import { $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link'
import {
  $isListNode,
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  ListNode,
  REMOVE_LIST_COMMAND,
} from '@lexical/list'
import { $createHeadingNode, $createQuoteNode, $isHeadingNode, $isQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import { $getNearestNodeOfType } from '@lexical/utils'
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
  type TextFormatType,
} from 'lexical'

export type BlockType = 'paragraph' | 'h1' | 'h2' | 'quote' | 'bullet' | 'number' | 'other'

export interface FormatState {
  bold: boolean
  italic: boolean
  underline: boolean
  strikethrough: boolean
  code: boolean
  link: boolean
  block: BlockType
}

/** Reads what the selection is in, for the buttons' active states. Call inside `editorState.read()`. */
export function $readFormat(): FormatState | null {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  const anchor = selection.anchor.getNode()
  const top = anchor.getTopLevelElementOrThrow()

  let block: BlockType = 'other'
  if ($isListNode(top)) {
    const list = $getNearestNodeOfType(anchor, ListNode)
    if (list === null) throw new Error('a list item is outside a list')
    block = list.getListType() === 'number' ? 'number' : 'bullet'
  } else if ($isHeadingNode(top)) {
    const tag = top.getTag()
    block = tag === 'h1' || tag === 'h2' ? tag : 'other'
  } else if ($isQuoteNode(top)) {
    block = 'quote'
  } else if (top.getType() === 'paragraph') {
    block = 'paragraph'
  }

  return {
    bold: selection.hasFormat('bold'),
    italic: selection.hasFormat('italic'),
    underline: selection.hasFormat('underline'),
    strikethrough: selection.hasFormat('strikethrough'),
    code: selection.hasFormat('code'),
    link: $isLinkNode(anchor) || $isLinkNode(anchor.getParent()),
    block,
  }
}

export function formatText(editor: LexicalEditor, format: TextFormatType): void {
  editor.dispatchCommand(FORMAT_TEXT_COMMAND, format)
}

/** Turns the selected blocks into `kind`, or back into paragraphs when they already are one, like the playground's dropdown. */
export function setBlock(editor: LexicalEditor, kind: 'paragraph' | 'h1' | 'h2' | 'quote', current: BlockType): void {
  if (current === 'bullet' || current === 'number') editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return
    $setBlocksType(selection, () => {
      if (kind === 'paragraph' || kind === current) return $createParagraphNode()
      if (kind === 'quote') return $createQuoteNode()
      return $createHeadingNode(kind)
    })
  })
}

export function toggleList(editor: LexicalEditor, kind: 'bullet' | 'number', current: BlockType): void {
  if (current === kind) editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined)
  else editor.dispatchCommand(kind === 'bullet' ? INSERT_UNORDERED_LIST_COMMAND : INSERT_ORDERED_LIST_COMMAND, undefined)
}

export function setLink(editor: LexicalEditor, url: string | null): void {
  editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
}
