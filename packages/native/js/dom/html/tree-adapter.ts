/**
 * The parse5 tree adapter over Ghia's DOM nodes: the parser builds `InertDocument` nodes through it,
 * and the serializer reads any node through it, a parsed one or an element of a window. No tree of
 * parse5's own is built and converted.
 */

import { html, type Token, type TreeAdapter, type TreeAdapterTypeMap } from "parse5"
import { INVALID_NAME } from "../../dom-members.js"
import { DOM_BINDING, type CharacterData, type DocumentFragment, type Element, type Node, type Text } from "../nodes.js"
import { InertComment, InertDocument, InertElement, InertFragment, InertText } from "./inert-nodes.js"

const NS = html.NS

const ELEMENT_NODE = 1
const TEXT_NODE = 3
const COMMENT_NODE = 8

type Map = TreeAdapterTypeMap<Node, Node, Node, InertDocument, DocumentFragment, Element, Node, Text, Element, never>

/** The fields the parser reads and writes of a node it has just made, which nothing else holds yet. */
type Link = Node & { parent: Node | null; kids?: Node[] }

function childrenOf(node: Node): Node[] {
  return node[DOM_BINDING]().children as Node[]
}

function link(parent: Node, child: Node, before: Node | null): void {
  const kids = (parent as Link).kids
  if (kids === undefined) throw new Error(`A <${parent.nodeName}> node of a parsed document holds no children`)
  const index = before === null ? kids.length : kids.indexOf(before)
  if (index < 0) throw new Error("The reference node is not a child of the parent")
  kids.splice(index, 0, child)
  ;(child as Link).parent = parent
}

function textOf(node: Node): string {
  return (node as CharacterData).data
}

function qualifiedName(attribute: Token.Attribute): string {
  return attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name
}

/**
 * A name `setAttribute` rejects is dropped: the tokenizer lets a few through (`=a`), and a parsed
 * element cannot hold them.
 */
function setParsedAttributes(element: Element, attributes: readonly Token.Attribute[], onlyMissing: boolean): void {
  for (const attribute of attributes) {
    const name = qualifiedName(attribute)
    if (INVALID_NAME.test(name)) continue
    if (onlyMissing && element.hasAttribute(name)) continue
    element.setAttribute(name, attribute.value)
  }
}

/** The adapter that builds the nodes of `document`; the reading half works on any node. */
export function createTreeAdapter(document: InertDocument): TreeAdapter<Map> {
  return {
    createDocument: () => document,
    createDocumentFragment: () => new InertFragment(document) as unknown as DocumentFragment,
    createElement(tagName, namespaceURI, attributes) {
      const element = document.makeElement(tagName, namespaceURI)
      setParsedAttributes(element, attributes, false)
      return element
    },
    createCommentNode: (data) => new InertComment(document, data) as unknown as Node,
    createTextNode: (value) => new InertText(document, value) as unknown as Text,

    appendChild: (parent, child) => link(parent, child, null),
    insertBefore: (parent, child, reference) => link(parent, child, reference),
    detachNode(node) {
      const parent = (node as Link).parent
      if (parent === null) return
      const kids = (parent as Link).kids
      if (kids === undefined) throw new Error("The parent of the node holds no children")
      // The parser detaches a node's children from the last one, so a search from the end is the first hit.
      kids.splice(kids.lastIndexOf(node), 1)
      ;(node as Link).parent = null
    },
    insertText(parent, text) {
      const last = childrenOf(parent).at(-1)
      if (last !== undefined && last.nodeType === TEXT_NODE) (last as InertText).text += text
      else link(parent, new InertText(document, text) as unknown as Node, null)
    },
    insertTextBefore(parent, text, reference) {
      const kids = childrenOf(parent)
      const previous = kids[kids.indexOf(reference) - 1]
      if (previous !== undefined && previous.nodeType === TEXT_NODE) (previous as InertText).text += text
      else link(parent, new InertText(document, text) as unknown as Node, reference)
    },
    adoptAttributes: (recipient, attributes) => setParsedAttributes(recipient, attributes, true),

    setTemplateContent(template, content) {
      ;(template as unknown as InertElement).templateContent = content as unknown as InertFragment
    },
    getTemplateContent(template) {
      const content = (template as unknown as InertElement).templateContent
      if (content === undefined) throw new Error("A <template> of a window has no content: only a parsed document has them")
      return content
    },
    setDocumentMode(target, mode) {
      target.quirksMode = mode === html.DOCUMENT_MODE.QUIRKS
    },
    getDocumentMode: (target) => (target.quirksMode ? html.DOCUMENT_MODE.QUIRKS : html.DOCUMENT_MODE.NO_QUIRKS),
    // A parsed document has no doctype node: `document.doctype` is null.
    setDocumentType() {},
    getDocumentTypeNodeName: () => "",
    getDocumentTypeNodePublicId: () => "",
    getDocumentTypeNodeSystemId: () => "",

    getParentNode: (node) => node.parentNode,
    getChildNodes: childrenOf,
    getFirstChild: (node) => childrenOf(node)[0] ?? null,
    getTagName: (element) => element.localName,
    getNamespaceURI: (element) => element.namespaceURI as html.NS,
    getAttrList(element) {
      return element.getAttributeNames().map((name) => {
        const value = element.getAttribute(name)
        if (value === null) throw new Error(`The attribute "${name}" is listed and has no text`)
        return { name, value }
      })
    },
    getTextNodeContent: textOf,
    getCommentNodeContent: textOf,

    isElementNode: (node): node is Element => node.nodeType === ELEMENT_NODE,
    isTextNode: (node): node is Text => node.nodeType === TEXT_NODE,
    isCommentNode: (node): node is Node => node.nodeType === COMMENT_NODE,
    isDocumentTypeNode: (_node): _node is never => false,

    // Source locations are never asked for.
    getNodeSourceCodeLocation: () => null,
    setNodeSourceCodeLocation() {},
    updateNodeSourceCodeLocation() {},
  }
}
