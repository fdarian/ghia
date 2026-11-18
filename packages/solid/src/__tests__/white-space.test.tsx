import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const LINE = 20
const TEXT = { fontSize: 16, lineHeight: `${LINE}px`, fontFamily: "Menlo" } as const

type App = ReturnType<typeof createTestRoot>

function lines(app: App, testId: string) {
  const element = app.renderer.findByTestId(testId)
  expect(element).toBeDefined()
  const bounds = app.renderer.getElementBounds(element!.id)
  expect(bounds).not.toBeNull()
  return Math.round(bounds!.height / LINE)
}

function paint(view: () => any) {
  const app = createTestRoot()
  app.render(view)
  return app
}

describe.skipIf(!hasNativeTestRenderer)("Solid white-space", () => {
  it("collapses spaces, tabs and line feeds, and a line feed is a space", () => {
    const app = paint(() => (
      <div testId="p" style={{ width: 400, ...TEXT }}>
        {"a   b\t\tc\n\n  d\ne"}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["a b c d e"])
    expect(lines(app, "p")).toBe(1)
  })

  it("collapses across span edges and strips the paragraph's ends, as a signal changes", () => {
    const [word, setWord] = createSignal("  b  ")
    const app = paint(() => (
      <div testId="p" style={{ width: 400, ...TEXT }}>
        {"  \n a  "}
        <span style={{ fontWeight: 700 }}>{word()}</span>
        {"  c \n"}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["a b c"])

    app.flushSync(() => setWord("   "))
    expect(app.renderer.getPaintedText()).toEqual(["a c"])

    app.flushSync(() => setWord(" \n b\t"))
    expect(app.renderer.getPaintedText()).toEqual(["a b c"])
    expect(lines(app, "p")).toBe(1)
  })

  it("nowrap collapses and does not wrap", () => {
    const app = paint(() => (
      <div testId="p" style={{ width: 100, whiteSpace: "nowrap", ...TEXT }}>
        {"alpha   beta \n gamma   delta"}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["alpha beta gamma delta"])
    expect(lines(app, "p")).toBe(1)
  })

  it("pre keeps spaces, breaks at line feeds and does not wrap", () => {
    const app = paint(() => (
      <div testId="p" style={{ width: 80, whiteSpace: "pre", ...TEXT }}>
        {"  a  b\n    a very long second line\n"}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["  a  b\n    a very long second line"])
    expect(lines(app, "p")).toBe(2)
  })

  it("pre-wrap keeps spaces and wraps", () => {
    const app = paint(() => (
      <div testId="p" style={{ width: 100, whiteSpace: "pre-wrap", ...TEXT }}>
        {"alpha  beta  gamma\ndelta"}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["alpha  beta  gamma\ndelta"])
    expect(lines(app, "p")).toBeGreaterThan(2)
  })

  it("pre-line collapses spaces and keeps line feeds", () => {
    const app = paint(() => (
      <div testId="p" style={{ width: 400, whiteSpace: "pre-line", ...TEXT }}>
        {"  a   b  \n   c\n\nd  "}
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["a b\nc\n\nd"])
    expect(lines(app, "p")).toBe(4)
  })

  it("inherits white-space, and a descendant or a span can override it", () => {
    const app = paint(() => (
      <div style={{ width: 400, whiteSpace: "pre", ...TEXT }}>
        <div>{"a  b"}</div>
        <div style={{ whiteSpace: "normal" }}>{"a  b"}</div>
        <div>
          {"c  "}
          <span style={{ whiteSpace: "normal" }}>{"d   e"}</span>
        </div>
      </div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["a  b", "a b", "c  d e"])
  })

  it("follows a change of the container", () => {
    const [mode, setMode] = createSignal<"normal" | "pre">("normal")
    const app = paint(() => (
      <div style={{ width: 400, whiteSpace: mode(), ...TEXT }}>{"a   b"}</div>
    ))
    expect(app.renderer.getPaintedText()).toEqual(["a b"])
    app.flushSync(() => setMode("pre"))
    expect(app.renderer.getPaintedText()).toEqual(["a   b"])
  })

  describe("search, selection and lookup after collapsing", () => {
    const view = (query: string) => () => (
      <div style={{ width: 600 }} highlight={{ query }}>
        <div style={{ ...TEXT, fontSize: 20 }}>
          {"alpha   \n  "}
          <span style={{ fontWeight: 700 }}>{"  beta  "}</span>
          {"   gamma"}
          <span style={{ backgroundColor: "#ffff00" }}>{"   \n  delta  "}</span>
        </div>
      </div>
    )

    it("matches the collapsed text across a span edge, and not the raw one", () => {
      const hits = paint(view("a beta g")).renderer.getPaintedHighlights()
      expect(hits).toHaveLength(1)
      expect(hits[0].text).toBe("alpha beta gamma delta")
      expect(hits[0].text.slice(hits[0].start, hits[0].end)).toBe("a beta g")
      expect(paint(view("alpha   ")).renderer.getPaintedHighlights()).toEqual([])
    })

    it("selects a later span from where it is painted", () => {
      const app = paint(view("delta"))
      const rect = app.renderer.getPaintedHighlights()[0].rects[0]
      const y = rect.y + rect.height / 2
      expect(app.renderer.dragSelect(rect.x + 1, y, rect.x + rect.width + 4, y)).toBe("delta")
    })

    it("copies the collapsed paragraph", () => {
      const app = paint(view("alpha"))
      expect(app.renderer.dragSelect(1, 10, 590, 10)).toBe("alpha beta gamma delta")
    })

    it("finds an element by its collapsed text", () => {
      const app = paint(() => <div style={TEXT}>{"hello  \n   world"}</div>)
      expect(app.renderer.findByText("hello world")).toBeDefined()
    })
  })

  describe("a block whose only content is a line break", () => {
    function heights(app: App, ids: string[]) {
      return ids.map((id) => app.renderer.getElementBounds(app.renderer.findByTestId(id)!.id)!.height)
    }

    it("is one line tall, as Chrome lays it out (a trailing <br> adds no line, a second one adds a line)", () => {
      const app = paint(() => (
        <div style={{ width: 400, ...TEXT }}>
          <div testId="text">one</div>
          <div testId="br">
            <br />
          </div>
          <div testId="trailing">
            a
            <br />
          </div>
          <div testId="two">
            <br />
            <br />
          </div>
          <div testId="space">
            {" "}
            <br />
            {" "}
          </div>
          <div testId="span">
            <span />
          </div>
        </div>
      ))
      // The oracle: `<div><br></div>` 20, `a<br>` 20, `<br><br>` 40, an empty `<span>` 0 (headless Chrome, 16px/20px).
      expect(heights(app, ["text", "br", "trailing", "two", "space", "span"])).toEqual([LINE, LINE, LINE, 2 * LINE, LINE, 0])
    })

    it("is a line of the block's own line height", () => {
      const app = paint(() => (
        <div style={{ width: 400, ...TEXT }}>
          <p testId="p" style={{ margin: 0, lineHeight: "30px" }}>
            <br />
          </p>
          <div testId="after">after</div>
        </div>
      ))
      expect(heights(app, ["p", "after"])).toEqual([30, LINE])
    })

    it("is one line when the line feed is a preserved one", () => {
      const app = paint(() => (
        <div style={{ width: 400, ...TEXT }}>
          <div testId="one" style={{ whiteSpace: "pre" }}>
            {"\n"}
          </div>
          <div testId="two" style={{ whiteSpace: "pre" }}>
            {"\n\n"}
          </div>
        </div>
      ))
      expect(heights(app, ["one", "two"])).toEqual([LINE, 2 * LINE])
    })

    it("has no text to paint, find or copy", () => {
      const app = paint(() => (
        <div style={{ width: 400, ...TEXT }}>
          <div>
            <br />
          </div>
        </div>
      ))
      expect(app.renderer.getPaintedText()).toEqual([])
    })
  })
})
