import { describe, expect, it } from "vitest"
import "../dom-globals.js"
import { CSSStyleRule } from "../css/index.js"
import { DOM_BINDING } from "../dom/nodes.js"
import { appliedBatchCount } from "../testing.js"

const CHROME_CLIPBOARD = `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-x"><p dir="ltr"><span style="font-size:11pt;color:#000000">Hello</span></p></b>`

function parse(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/html")
}

function shape(node: Node): string {
  if (node.nodeType === 3) return JSON.stringify(node.textContent)
  if (node.nodeType === 8) return `<!--${(node as Comment).data}-->`
  const children = Array.from(node.childNodes).map(shape).join(" ")
  return `${node.nodeName.toLowerCase()}${children === "" ? "" : `(${children})`}`
}

describe("DOMParser", () => {
  it("parses a Chrome clipboard fragment into html, head and body", () => {
    const doc = parse(CHROME_CLIPBOARD)
    expect(doc.nodeType).toBe(9)
    expect(doc.nodeName).toBe("#document")
    expect(shape(doc.documentElement)).toBe('html(head(meta) body(b(p(span("Hello")))))')
    expect(doc.head.firstElementChild?.getAttribute("charset")).toBe("utf-8")
    const bold = doc.body.firstElementChild as HTMLElement
    expect(bold.tagName).toBe("B")
    expect(bold.id).toBe("docs-internal-guid-x")
    expect(bold.style.fontWeight).toBe("normal")
    const paragraph = bold.firstElementChild as HTMLElement
    expect(paragraph.getAttribute("dir")).toBe("ltr")
    const span = doc.querySelector("span") as HTMLElement
    expect(span.style.color).toBe("#000000")
    expect(span.style.fontSize).toBe("11pt")
    expect(doc.body.textContent).toBe("Hello")
    expect(doc.documentElement.ownerDocument).toBe(doc)
    expect(doc.ownerDocument).toBe(null)
  })

  it("makes a document that answers the document members", () => {
    const doc = parse("<!doctype html><title>  A   title </title><p id=a class='x y'>one</p><p>two</p>")
    expect(doc.title).toBe("A title")
    expect(doc.contentType).toBe("text/html")
    expect(doc.compatMode).toBe("CSS1Compat")
    expect(doc.defaultView).toBe(null)
    expect(doc.getElementById("a")?.textContent).toBe("one")
    expect(doc.getElementsByTagName("p")).toHaveLength(2)
    expect(doc.querySelectorAll("p.x")).toHaveLength(1)
    expect(doc.querySelector("p.y")?.classList.contains("x")).toBe(true)
    expect(parse("<p>quirks").compatMode).toBe("BackCompat")
  })

  it("fixes up tables and lists the way the HTML parser does", () => {
    const doc = parse("<table><tr><td>a<td>b</table><ul><li>1<li>2</ul>")
    expect(shape(doc.body)).toBe('body(table(tbody(tr(td("a") td("b")))) ul(li("1") li("2")))')
  })

  it("keeps void elements, entities and comments", () => {
    const doc = parse("<p>a<br>b &amp; c &lt;d&gt; &nbsp;&#x41;&copy;<!-- note --><img src=x.png></p>")
    const paragraph = doc.querySelector("p") as HTMLElement
    expect(shape(paragraph)).toBe('p("a" br "b & c <d>  A©" <!-- note --> img)')
    expect(paragraph.childNodes[3]).toBeInstanceOf(Comment)
    expect(paragraph.children).toHaveLength(2)
    // A comment is no text of its parent.
    expect(paragraph.textContent).toBe("ab & c <d>  A©")
    expect(doc.querySelectorAll("*").length).toBe(6)
  })

  it("holds scripting off, so noscript has its elements", () => {
    const doc = parse("<p>a</p><noscript><p>x</p></noscript>")
    expect(shape(doc.body)).toBe('body(p("a") noscript(p("x")))')
  })

  it("makes SVG elements with their case and the SVG namespace", () => {
    const doc = parse('<svg viewBox="0 0 1 1"><foreignObject><p>x</p></foreignObject><linearGradient/></svg>')
    const svg = doc.querySelector("svg") as SVGElement
    expect(svg).toBeInstanceOf(SVGElement)
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg")
    expect(svg.getAttribute("viewBox")).toBe("0 0 1 1")
    expect(svg.querySelector("foreignObject")).not.toBe(null)
    expect(svg.querySelector("p")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml")
  })

  it("holds a template's children apart from its own", () => {
    const doc = parse("<template id=t><p>inside</p></template>")
    const template = doc.getElementById("t") as HTMLTemplateElement
    expect(template.childNodes).toHaveLength(0)
    expect(template.content.nodeType).toBe(11)
    expect(shape(template.content)).toBe('#document-fragment(p("inside"))')
    expect(doc.querySelector("p")).toBe(null)
  })

  it("reads <style> elements as style sheets, for reading", () => {
    const doc = parse("<style>p{color:red}.a, .b{margin:1px; padding:2px}</style><p>x</p><style>@media print{p{color:blue}}</style>")
    const sheets = doc.styleSheets
    expect(sheets).toHaveLength(2)
    expect(sheets).toBeInstanceOf(StyleSheetList)
    const first = sheets[0] as CSSStyleSheet
    expect(first).toBeInstanceOf(CSSStyleSheet)
    expect(first.ownerNode).toBe(doc.querySelector("style"))
    expect(first.cssRules).toHaveLength(2)
    const rule = first.cssRules[0] as CSSStyleRule
    expect(rule).toBeInstanceOf(CSSStyleRule)
    expect(rule.selectorText).toBe("p")
    expect(rule.style.color).toBe("red")
    const second = first.cssRules[1] as CSSStyleRule
    expect(second.selectorText).toBe(".a, .b")
    expect(second.style.margin).toBe("1px")
    expect(second.style.padding).toBe("2px")
    expect(Array.from(sheets)).toHaveLength(2)
    expect(sheets.item(5)).toBe(null)
    expect((sheets[1] as CSSStyleSheet).cssRules[0].type).toBe(4)
    expect(doc.styleSheets).toBe(sheets)
  })

  it("follows a <style> element's text", () => {
    const doc = parse("<style>p{color:red}</style>")
    const before = doc.styleSheets[0] as CSSStyleSheet
    doc.querySelector("style")!.textContent = "p{color:green}"
    const after = doc.styleSheets[0] as CSSStyleSheet
    expect(after).not.toBe(before)
    expect((after.cssRules[0] as CSSStyleRule).style.color).toBe("green")
    doc.querySelector("style")!.remove()
    expect(doc.styleSheets).toHaveLength(0)
  })

  it("is inert: in no window, no renderer and no document of the app", () => {
    const batches = appliedBatchCount()
    const doc = parse(CHROME_CLIPBOARD)
    const bold = doc.body.firstElementChild as HTMLElement
    bold.setAttribute("title", "t")
    bold.style.color = "red"
    bold.append("more")
    bold.addEventListener("click", () => {})
    bold.getBoundingClientRect()
    expect(appliedBatchCount()).toBe(batches)
    expect(bold.isConnected).toBe(false)
    expect(bold.getRootNode()).toBe(doc)
    expect((bold as unknown as Record<symbol, unknown>)[Symbol.for("@ghia/native/inert-document")]).toBe(doc)
    const binding = bold[DOM_BINDING]() as { native?: unknown; root: unknown }
    expect(binding.native).toBe(undefined)
    expect(binding.root).toBe(null)
    expect(document.documentElement.contains(bold)).toBe(false)
    expect(document.getElementById("docs-internal-guid-x")).toBe(null)
  })

  it("is a second document: its nodes keep to it", () => {
    const first = parse("<p>one</p>")
    const second = parse("<div></div>")
    expect(() => second.body.appendChild(first.body.firstElementChild!)).toThrowError(expect.objectContaining({ name: "WrongDocumentError" }))
    const clone = first.body.firstElementChild!.cloneNode(true)
    expect(clone.ownerDocument).toBe(first)
    first.body.appendChild(clone)
    expect(first.getElementsByTagName("p")).toHaveLength(2)
    const text = first.createTextNode("t")
    first.body.insertBefore(text, first.body.firstChild)
    expect(first.body.firstChild).toBe(text)
    expect(first.body.textContent).toBe("toneone")
  })

  it("makes nodes of its own", () => {
    const doc = parse("")
    const div = doc.createElement("DIV")
    expect(div.tagName).toBe("DIV")
    expect(div.ownerDocument).toBe(doc)
    div.append("a", doc.createComment("c"))
    expect(div.childNodes).toHaveLength(2)
    expect(div.textContent).toBe("a")
    expect(doc.createDocumentFragment().ownerDocument).toBe(doc)
    expect(doc.createElementNS("http://www.w3.org/2000/svg", "svg")).toBeInstanceOf(SVGElement)
  })

  it("refuses the XML types and an unknown one", () => {
    const parser = new DOMParser()
    for (const type of ["text/xml", "application/xml", "application/xhtml+xml", "image/svg+xml"]) {
      expect(() => parser.parseFromString("<a/>", type)).toThrowError(expect.objectContaining({ name: "NotSupportedError" }))
    }
    expect(() => parser.parseFromString("<a/>", "text/plain")).toThrowError(TypeError)
  })

  it("drops an attribute name setAttribute would refuse", () => {
    const doc = parse("<p =x=1 a=2>t</p>")
    expect(doc.querySelector("p")?.getAttributeNames()).toEqual(["a"])
  })
})
