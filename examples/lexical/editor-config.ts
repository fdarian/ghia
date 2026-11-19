import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  type ElementNode,
  type Klass,
  type LexicalNode,
  type TextFormatType,
} from 'lexical'
import { $createLinkNode } from '@lexical/link'
import { $createListItemNode, $createListNode } from '@lexical/list'
import { $createHeadingNode, $createQuoteNode } from '@lexical/rich-text'

export const nodes: Array<Klass<LexicalNode>> = [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode]

export const theme = {
  paragraph: 'ed-paragraph',
  quote: 'ed-quote',
  heading: { h1: 'ed-h1', h2: 'ed-h2', h3: 'ed-h3' },
  list: {
    ul: 'ed-ul',
    ol: 'ed-ol',
    listitem: 'ed-li',
    nested: { listitem: 'ed-nested-li' },
  },
  link: 'ed-link',
  text: {
    bold: 'ed-bold',
    italic: 'ed-italic',
    underline: 'ed-underline',
    strikethrough: 'ed-strikethrough',
    underlineStrikethrough: 'ed-underline-strikethrough',
    code: 'ed-code',
  },
}

function run(text: string, ...formats: TextFormatType[]) {
  const node = $createTextNode(text)
  for (const format of formats) node.toggleFormat(format)
  return node
}

function paragraph(...children: LexicalNode[]): ElementNode {
  return $createParagraphNode().append(...children)
}

function item(...children: LexicalNode[]): ElementNode {
  return $createListItemNode().append(...children)
}

/** One of everything the toolbar can make, so a first screenshot shows each style. */
export function $seed(): void {
  const link = $createLinkNode('https://lexical.dev')
  link.append($createTextNode('lexical.dev'))
  $getRoot().append(
    $createHeadingNode('h1').append($createTextNode('Notes on a native editor')),
    paragraph(
      $createTextNode('Lexical runs here with '),
      run('bold', 'bold'),
      $createTextNode(', '),
      run('italic', 'italic'),
      $createTextNode(', '),
      run('underlined', 'underline'),
      $createTextNode(', '),
      run('struck', 'strikethrough'),
      $createTextNode(' and '),
      run('code', 'code'),
      $createTextNode(' text, and links such as '),
      link,
      $createTextNode('. Select some words to get the floating toolbar.'),
    ),
    $createHeadingNode('h2').append($createTextNode('Lists')),
    $createListNode('bullet').append(
      item($createTextNode('The DOM, without a browser engine')),
      item($createTextNode('GPUI paints it on the GPU')),
      item($createTextNode('Undo and redo come from @lexical/history')),
    ),
    $createListNode('number').append(
      item($createTextNode('Click into the text')),
      item($createTextNode('Select a word')),
      item($createTextNode('Press a button in the floating toolbar')),
    ),
    $createQuoteNode().append($createTextNode('Code written for the web should work here unchanged.')),
    paragraph($createTextNode('Start typing below this line.')),
    paragraph(),
  )
}
