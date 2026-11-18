import { describe, expect, it } from "vitest"
import "../dom-globals.js"

function parse(markup: string): Document {
  return new DOMParser().parseFromString(markup, "text/html")
}

const scratch = parse("")

/** An element in a parsed document, which is where a test without a window makes nodes. */
function make(tag: string, ...children: Array<Node | string>): HTMLElement {
  const element = scratch.createElement(tag) as HTMLElement
  element.append(...children)
  return element
}

describe("innerHTML and outerHTML", () => {
  it("serializes what code built, as the Lexical export does", () => {
    const doc = parse("")
    const container = doc.createElement("div")
    const paragraph = doc.createElement("p")
    paragraph.setAttribute("dir", "ltr")
    paragraph.style.color = "red"
    const bold = doc.createElement("b")
    bold.append("bold")
    paragraph.append("a ", bold, doc.createElement("br"), " b")
    container.append(paragraph)
    expect(container.innerHTML).toBe('<p dir="ltr" style="color: red;">a <b>bold</b><br> b</p>')
    expect(paragraph.outerHTML).toBe('<p dir="ltr" style="color: red;">a <b>bold</b><br> b</p>')
    expect(bold.outerHTML).toBe("<b>bold</b>")
    expect(doc.createElement("div").innerHTML).toBe("")
  })

  it("escapes text and attributes", () => {
    const element = make("p", "1 < 2 & 3 > 2  ")
    element.setAttribute("title", 'say "hi" & <go> ')
    expect(element.outerHTML).toBe('<p title="say &quot;hi&quot; &amp; &lt;go&gt;&nbsp;">1 &lt; 2 &amp; 3 &gt; 2 &nbsp;</p>')
  })

  it("writes void elements without an end tag, and raw text as it is", () => {
    const style = make("style", "a > b { content: '<&>' }")
    expect(make("div", make("br"), make("img"), style).innerHTML).toBe("<br><img><style>a > b { content: '<&>' }</style>")
    const image = make("img")
    image.setAttribute("src", "a.png")
    expect(image.outerHTML).toBe('<img src="a.png">')
  })

  it("serializes a template's content", () => {
    const doc = parse("<i></i><template><p>in &amp; out</p></template>")
    expect(doc.body.innerHTML).toBe("<i></i><template><p>in &amp; out</p></template>")
  })

  it("keeps comments of a parsed document", () => {
    expect(parse("<p>a<!--c-->b</p>").body.innerHTML).toBe("<p>a<!--c-->b</p>")
  })

  it("serializes SVG and its attributes", () => {
    const svg = parse('<svg viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>').querySelector("svg")!
    expect(svg.outerHTML).toBe('<svg viewBox="0 0 1 1" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"></use></svg>')
  })

  it("round-trips a Chrome clipboard fragment", () => {
    const html =
      '<b id="docs-internal-guid-x" style="font-weight: normal;"><p dir="ltr"><span style="font-size: 11pt; color: #000000;">Hello &amp; bye</span></p></b>'
    expect(parse(html).body.innerHTML).toBe(html)
    expect(parse(parse(html).body.innerHTML).body.innerHTML).toBe(html)
  })

  it("sets innerHTML in the context of the element", () => {
    const doc = parse("<table><tbody id=t></tbody></table><div id=d>old<b>old</b></div>")
    const body = doc.getElementById("t")!
    body.innerHTML = "<tr><td>a</td></tr>"
    expect(body.innerHTML).toBe("<tr><td>a</td></tr>")
    const div = doc.getElementById("d")!
    div.innerHTML = "<tr><td>a</td></tr>x"
    expect(div.innerHTML).toBe("ax")
    div.innerHTML = '<p class="x">new</p><!--c-->'
    expect(div.children).toHaveLength(1)
    expect(div.firstElementChild!.parentNode).toBe(div)
    expect(div.firstElementChild!.ownerDocument).toBe(doc)
    div.innerHTML = ""
    expect(div.childNodes).toHaveLength(0)
    div.innerHTML = null as unknown as string
    expect(div.innerHTML).toBe("")
  })

  it("replaces an element with its outerHTML setter", () => {
    const doc = parse("<div id=a><p id=b>old</p><i>keep</i></div>")
    doc.getElementById("b")!.outerHTML = "<span>x</span>y"
    expect(doc.getElementById("a")!.innerHTML).toBe("<span>x</span>y<i>keep</i>")
    const orphan = make("p")
    orphan.outerHTML = "<b></b>"
    expect(orphan.outerHTML).toBe("<p></p>")
    expect(() => {
      doc.documentElement.outerHTML = "<html></html>"
    }).toThrowError(expect.objectContaining({ name: "NoModificationAllowedError" }))
  })

  it("inserts markup at the four positions", () => {
    const doc = parse("<div id=a><i>1</i><b id=b>2</b><u>3</u></div>")
    const middle = doc.getElementById("b")!
    middle.insertAdjacentHTML("beforebegin", "<s>a</s>")
    middle.insertAdjacentHTML("afterbegin", "<s>b</s>")
    middle.insertAdjacentHTML("beforeend", "<s>c</s>")
    middle.insertAdjacentHTML("AFTEREND", "<s>d</s>")
    expect(doc.getElementById("a")!.innerHTML).toBe("<i>1</i><s>a</s><b id=\"b\"><s>b</s>2<s>c</s></b><s>d</s><u>3</u>")
    expect(() => middle.insertAdjacentHTML("inside", "")).toThrowError(expect.objectContaining({ name: "SyntaxError" }))
    expect(() => make("p").insertAdjacentHTML("beforebegin", "<b></b>")).toThrowError(expect.objectContaining({ name: "NoModificationAllowedError" }))
  })

  it("moves nothing across documents when it sets markup", () => {
    const doc = parse("<div id=a></div>")
    const other = parse("<p id=b>x</p>")
    doc.getElementById("a")!.innerHTML = other.body.innerHTML
    expect(doc.getElementById("a")!.innerHTML).toBe('<p id="b">x</p>')
    expect(other.getElementById("b")!.parentNode).toBe(other.body)
  })

  it("serializes a template's contents when it is set", () => {
    const doc = parse("<div id=a></div>")
    doc.getElementById("a")!.innerHTML = "<template><b>t</b></template>"
    expect(doc.getElementById("a")!.innerHTML).toBe("<template><b>t</b></template>")
  })
})
