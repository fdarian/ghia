/** `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `DOMParser` over a Solid tree. */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { appliedBatchCount } from "@ghia/native/testing"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("markup members in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot()
  })

  afterEach(() => {
    app.unmount()
  })

  async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    app.renderer.flush()
  }

  function mountHost(): HTMLElement {
    app.render(() => (
      <div id="host">
        <p class="x">one</p>
        <b>two</b>
      </div>
    ))
    return document.getElementById("host") as HTMLElement
  }

  it("renders the markup set as innerHTML", async () => {
    let host: HTMLDivElement | null = null
    app.render(() => <div ref={(element) => (host = element)}>old</div>)
    await settle()
    host!.innerHTML = '<p style="color:red">hello <b>world</b></p><!-- gone -->&amp; more'
    await settle()
    expect(app.renderer.findByText("hello")).toBeDefined()
    expect(app.renderer.findByText("world")).toBeDefined()
    expect(app.renderer.findByText("old")).toBeUndefined()
    expect(host!.childNodes).toHaveLength(2)
    const paragraph = host!.firstElementChild as HTMLElement
    expect(paragraph.style.color).toBe("red")
    expect(paragraph.isConnected).toBe(true)
    expect(app.renderer.findByType("b")).toHaveLength(1)
    expect(host!.lastChild!.textContent).toBe("& more")
  })

  it("serializes a rendered tree", async () => {
    const host = mountHost()
    await settle()
    expect(host.innerHTML).toBe('<p class="x">one</p><b>two</b>')
    expect(host.outerHTML).toBe('<div id="host"><p class="x">one</p><b>two</b></div>')
  })

  it("serializes what code made with the document, as Lexical's export does", async () => {
    mountHost()
    await settle()
    const container = document.createElement("div")
    const paragraph = document.createElement("p")
    const bold = document.createElement("b")
    bold.append("bold")
    paragraph.append("a ", bold, document.createElement("br"))
    paragraph.style.color = "red"
    container.append(paragraph)
    expect(container.innerHTML).toBe('<p style="color: red;">a <b>bold</b><br></p>')
  })

  it("replaces an element with outerHTML and inserts beside one", async () => {
    const host = mountHost()
    await settle()
    host.querySelector("p")!.outerHTML = "<i>new</i>"
    host.querySelector("b")!.insertAdjacentHTML("afterend", "<u>after</u>")
    host.insertAdjacentHTML("afterbegin", "<s>first</s>")
    await settle()
    expect(host.innerHTML).toBe("<s>first</s><i>new</i><b>two</b><u>after</u>")
    expect(app.renderer.findByText("after")).toBeDefined()
    expect(app.renderer.findByText("one")).toBeUndefined()
  })

  it("refuses markup with an element Ghia does not draw, and changes nothing", async () => {
    const host = mountHost()
    await settle()
    expect(() => {
      host.innerHTML = "<p>fine</p><marquee>no</marquee>"
    }).toThrowError(expect.objectContaining({ name: "NotSupportedError" }))
    expect(host.innerHTML).toBe('<p class="x">one</p><b>two</b>')
  })

  it("parses a document that never reaches the renderer", async () => {
    const host = mountHost()
    await settle()
    const before = appliedBatchCount()
    const parsed = new DOMParser().parseFromString('<p id="p">parsed <b>text</b></p>', "text/html")
    parsed.getElementById("p")!.setAttribute("title", "t")
    parsed.body.append("more")
    await settle()
    expect(appliedBatchCount()).toBe(before)
    expect(app.renderer.findByText("parsed")).toBeUndefined()
    expect(() => host.appendChild(parsed.getElementById("p")!)).toThrowError(expect.objectContaining({ name: "WrongDocumentError" }))
    host.innerHTML = parsed.body.innerHTML
    await settle()
    expect(app.renderer.findByText("parsed")).toBeDefined()
    expect(host.firstElementChild!.getAttribute("title")).toBe("t")
  })
})
