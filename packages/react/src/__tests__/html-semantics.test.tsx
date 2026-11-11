/// What the HTML tags mean beyond their look: the implicit ARIA role, focus (a `button` and an `a[href]` are
/// tab stops), Enter and Space clicking them, and a `button` submitting its `form`.
// @ts-nocheck

import React from "react"
import { beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type A11yTreeDump } from "../testing.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

type TestRoot = ReturnType<typeof createTestRoot>

function byAuthorId(tree: A11yTreeDump, authorId: string) {
  const aria = Object.values(tree.nodes ?? {})
    .map((node) => node.aria)
    .find((aria) => aria?.author_id === authorId)
  if (!aria) throw new Error(`no a11y node with author id ${authorId}`)
  return aria
}

const hasNode = (tree: A11yTreeDump, authorId: string) =>
  Object.values(tree.nodes ?? {}).some((node) => node.aria?.author_id === authorId)

describeNative("HTML tag roles", () => {
  let testRoot: TestRoot
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 800 })
  })

  const roleOf = (authorId: string) => byAuthorId(testRoot.renderer.getA11yTree(), authorId).role

  it("gives each tag the role HTML gives it", () => {
    testRoot.render(
      <div>
        <button id="button">Go</button>
        <a id="link" href="/there" style={{ display: "block" }}>Link</a>
        <ul id="ul"><li id="li">one</li></ul>
        <ol id="ol"><li>one</li></ol>
        <nav id="nav"><p>menu</p></nav>
        <main id="main"><p>body</p></main>
        <aside id="aside"><p>side</p></aside>
        <article id="article"><p>story</p></article>
        <hr id="hr" />
        <blockquote id="blockquote"><p>said</p></blockquote>
        <p id="p">paragraph</p>
        <figure id="figure"><p>caption</p></figure>
        <fieldset id="fieldset"><p>fields</p></fieldset>
        <details id="details"><summary>more</summary><p>body</p></details>
        <dl id="dl"><dt id="dt">term</dt><dd id="dd">meaning</dd></dl>
        <table id="table">
          <thead id="thead"><tr id="tr"><th id="th">head</th></tr></thead>
          <tbody id="tbody"><tr><td id="td">cell</td></tr></tbody>
          <tfoot id="tfoot"><tr><td>foot</td></tr></tfoot>
        </table>
      </div>,
    )
    expect({
      button: roleOf("button"),
      link: roleOf("link"),
      ul: roleOf("ul"),
      ol: roleOf("ol"),
      li: roleOf("li"),
      nav: roleOf("nav"),
      main: roleOf("main"),
      aside: roleOf("aside"),
      article: roleOf("article"),
      hr: roleOf("hr"),
      blockquote: roleOf("blockquote"),
      p: roleOf("p"),
      figure: roleOf("figure"),
      fieldset: roleOf("fieldset"),
      details: roleOf("details"),
      dl: roleOf("dl"),
      dt: roleOf("dt"),
      dd: roleOf("dd"),
      table: roleOf("table"),
      thead: roleOf("thead"),
      tbody: roleOf("tbody"),
      tfoot: roleOf("tfoot"),
      tr: roleOf("tr"),
      th: roleOf("th"),
      td: roleOf("td"),
    }).toEqual({
      button: "Button",
      link: "Link",
      ul: "List",
      ol: "List",
      li: "ListItem",
      nav: "Navigation",
      main: "Main",
      aside: "Complementary",
      article: "Article",
      hr: "Splitter",
      blockquote: "Blockquote",
      p: "Paragraph",
      figure: "Figure",
      fieldset: "Group",
      details: "Group",
      dl: "DescriptionList",
      dt: "Term",
      dd: "Definition",
      table: "Table",
      thead: "RowGroup",
      tbody: "RowGroup",
      tfoot: "RowGroup",
      tr: "Row",
      th: "ColumnHeader",
      td: "Cell",
    })
  })

  it("names a button and a link from their content", () => {
    testRoot.render(
      <div>
        <button id="button">Save <strong>now</strong></button>
        <a id="link" href="/there" style={{ display: "block" }}>Read more</a>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "button").label).toBe("Save now")
    expect(byAuthorId(tree, "link").label).toBe("Read more")
  })

  it("gives a link a role only with an href", () => {
    const render = (href?: string) => testRoot.render(<a id="anchor" href={href} style={{ display: "block" }}>text</a>)
    render(undefined)
    expect(roleOf("anchor")).not.toBe("Link")
    render("/there")
    expect(roleOf("anchor")).toBe("Link")
    render(undefined)
    expect(roleOf("anchor")).not.toBe("Link")
  })

  it("gives a heading its level, and aria-level wins", () => {
    testRoot.render(
      <div>
        <h1 id="h1">one</h1>
        <h2 id="h2">two</h2>
        <h3 id="h3">three</h3>
        <h4 id="h4">four</h4>
        <h5 id="h5">five</h5>
        <h6 id="h6">six</h6>
        <h2 id="raised" aria-level={5}>raised</h2>
        <h1 id="demoted" role="button">not a heading</h1>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    for (const level of [1, 2, 3, 4, 5, 6]) {
      const heading = byAuthorId(tree, `h${level}`)
      expect([heading.role, heading.level, heading.label]).toEqual(["Heading", level, ["one", "two", "three", "four", "five", "six"][level - 1]])
    }
    expect(byAuthorId(tree, "raised").level).toBe(5)
    expect(byAuthorId(tree, "demoted")).toMatchObject({ role: "Button" })
    expect(byAuthorId(tree, "demoted").level).toBeUndefined()
  })

  it("makes a section a region only with an accessible name", () => {
    testRoot.render(
      <div>
        <section id="unnamed"><p>a</p></section>
        <section id="named" aria-label="Notes"><p>b</p></section>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(hasNode(tree, "unnamed") ? byAuthorId(tree, "unnamed").role : null).not.toBe("Region")
    expect(byAuthorId(tree, "named")).toMatchObject({ role: "Region", label: "Notes" })
  })

  it("makes a header and a footer the banner and the content info only outside sectioning content", () => {
    testRoot.render(
      <div>
        <header id="page-header"><p>top</p></header>
        <footer id="page-footer"><p>bottom</p></footer>
        <main>
          <header id="main-header"><p>in main</p></header>
        </main>
        <article><footer id="article-footer"><p>in article</p></footer></article>
        <section aria-label="s"><div><header id="deep-header"><p>deep</p></header></div></section>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "page-header").role).toBe("Banner")
    expect(byAuthorId(tree, "page-footer").role).toBe("ContentInfo")
    for (const id of ["main-header", "article-footer", "deep-header"]) {
      const role = hasNode(tree, id) ? byAuthorId(tree, id).role : null
      expect(String(role), id).not.toMatch(/Banner|ContentInfo/)
    }
  })

  it("lets an explicit role win", () => {
    testRoot.render(
      <div>
        <button id="tab" role="tab">One</button>
        <a id="plain" href="/x" role="button" style={{ display: "block" }}>Two</a>
        <p id="quiet" role="presentation">Three</p>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "tab").role).toBe("Tab")
    expect(byAuthorId(tree, "plain").role).toBe("Button")
    expect(hasNode(tree, "quiet") ? byAuthorId(tree, "quiet").role : null).not.toBe("Paragraph")
  })

  it("does not read the break opportunities of wbr out", () => {
    testRoot.render(
      <p id="long">
        super<wbr />cali<wbr />fragilistic
      </p>,
    )
    const paragraph = byAuthorId(testRoot.renderer.getA11yTree(), "long")
    expect(paragraph.value).toBe("supercalifragilistic")
  })

  it("copies a paragraph with wbr without the break opportunity, as Chrome does", () => {
    testRoot.render(
      <p testId="p" style={{ width: 400, margin: 0, fontSize: 16, lineHeight: "20px", fontFamily: "Menlo" }}>
        foo<wbr />bar baz
      </p>,
    )
    const box = testRoot.renderer.getElementBounds(testRoot.renderer.findByTestId("p").id)
    const y = box.y + 10
    expect(testRoot.renderer.dragSelect(box.x + 1, y, box.x + box.width - 1, y)).toBe("foobar baz")
  })

  it("finds a query across the wbr in a paragraph, and highlights what Chrome's find does", () => {
    for (const caseSensitive of [false, true]) {
      const { render, renderer, unmount } = createTestRoot({ width: 600, height: 800 })
      try {
        const counts: number[] = []
        render(
          <div highlight={{ query: "foobar", caseSensitive }} onHighlight={(event) => counts.push(event.matchCount ?? -1)}>
            <p style={{ margin: 0 }}>
              say foo<wbr />bar<wbr /> and foo<wbr />baz
            </p>
          </div>,
        )
        renderer.dispatchNativeEvents()
        expect(counts, `case sensitive: ${caseSensitive}`).toEqual([1])
        const painted = renderer.getPaintedHighlights().map((hit) => hit.text.slice(hit.start, hit.end))
        expect(painted, `case sensitive: ${caseSensitive}`).toEqual(["foo\u200Bbar"])
      } finally {
        unmount()
      }
    }
  })

  it("exposes a press on a button and not on a plain paragraph", () => {
    testRoot.render(
      <div>
        <button id="button">Go</button>
        <p id="plain">text</p>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "button").on_action).toEqual(expect.arrayContaining(["Click"]))
    expect(byAuthorId(tree, "plain").on_action ?? []).not.toContain("Click")
  })
})

describeNative("HTML tag focus", () => {
  let testRoot: TestRoot
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 400 })
  })

  const focused = () => testRoot.renderer.getElement(testRoot.renderer.getFocusedElementId())?.testId ?? null
  const tab = (keys = "Tab") => testRoot.renderer.simulateKeystrokes(keys)

  it("makes a button and an a[href] tab stops and an a without an href not", () => {
    testRoot.render(
      <div>
        <button testId="button">Go</button>
        <a testId="no-href">no href</a>
        <a testId="link" href="/there">link</a>
        <div testId="stop" tabIndex={0}>stop</div>
        <p testId="paragraph">text</p>
      </div>,
    )
    tab()
    expect(focused()).toBe("button")
    tab()
    expect(focused()).toBe("link")
    tab()
    expect(focused()).toBe("stop")
    tab("Shift+Tab")
    expect(focused()).toBe("link")
    tab("Shift+Tab")
    expect(focused()).toBe("button")
  })

  it("keeps a disabled button out of the order and out of focus", () => {
    testRoot.render(
      <div>
        <button testId="off" disabled>Off</button>
        <button testId="forced" disabled tabIndex={0}>Off</button>
        <button testId="on">On</button>
      </div>,
    )
    tab()
    expect(focused()).toBe("on")
    testRoot.renderer.focusElement(testRoot.renderer.findByTestId("forced").id)
    testRoot.renderer.flush()
    expect(focused()).toBe("on")
  })

  it("lets tabIndex order or remove a button and a link, and follows href and disabled as they change", () => {
    const view = (props: { href?: string; disabled?: boolean }) => (
      <div>
        <div><button testId="skipped" tabIndex={-1}>skip</button></div>
        <div><button testId="late" tabIndex={2}>late</button></div>
        <div><button testId="early" tabIndex={1}>early</button></div>
        <div><a testId="anchor" href={props.href} tabIndex={0}>a</a></div>
        <div><button testId="toggled" disabled={props.disabled}>t</button></div>
      </div>
    )
    testRoot.render(view({ href: "/x", disabled: false }))
    tab()
    expect(focused()).toBe("early")
    tab()
    expect(focused()).toBe("late")
    tab()
    expect(focused()).toBe("anchor")
    tab()
    expect(focused()).toBe("toggled")

    testRoot.render(view({ href: undefined, disabled: true }))
    testRoot.renderer.focusElement(testRoot.renderer.findByTestId("late").id)
    testRoot.renderer.flush()
    expect(focused()).toBe("late")
    tab()
    // Still a tab stop by its tabIndex, so a link without an href is reached; the disabled button is not.
    expect(focused()).toBe("anchor")
    tab()
    expect(focused()).toBe("early")
  })
})

describeNative("HTML tag activation", () => {
  let testRoot: TestRoot
  let log: string[]
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 400 })
    log = []
  })

  const idOf = (testId: string) => testRoot.renderer.findByTestId(testId).id
  const keys = (testId: string, keystrokes: string) => testRoot.renderer.nativeSimulateKeystrokes(idOf(testId), keystrokes)
  const down = (testId: string, key: string, held = false) => testRoot.renderer.nativeSimulateKeyDown(idOf(testId), key, held)
  const up = (testId: string, key: string) => testRoot.renderer.nativeSimulateKeyUp(idOf(testId), key)
  const click = (event) => log.push(`click:${event.target.props.testId}:${event.detail}`)

  it("clicks a focused button on Enter key down, with the DOM's non-pointer click", () => {
    const events: object[] = []
    testRoot.render(
      <div onKeyDown={(event) => log.push(`down:${event.key}`)} onKeyUp={(event) => log.push(`up:${event.key}`)}>
        <button testId="button" onClick={(event) => { events.push(event); click(event) }}>Go</button>
      </div>,
    )
    down("button", "Enter")
    expect(log).toEqual(["down:Enter", "click:button:0"])
    up("button", "Enter")
    expect(log).toEqual(["down:Enter", "click:button:0", "up:Enter"])
    expect(events[0]).toMatchObject({ pointerId: -1, pointerType: "" })
  })

  it("clicks on Space key up, not key down, and does not scroll", () => {
    testRoot.render(
      <div style={{ width: 200, height: 60, overflow: "scroll" }} testId="scroller">
        <button testId="button" onClick={click} style={{ height: 40 }}>Go</button>
        <div style={{ height: 400 }} />
      </div>,
    )
    down("button", "Space")
    expect(log).toEqual([])
    up("button", "Space")
    expect(log).toEqual(["click:button:0"])
    expect(testRoot.renderer.getScrollMetrics(idOf("scroller"))?.[1]).toBe(0)
  })

  it("clicks a button once for Space down and up in one press", () => {
    testRoot.render(<button testId="button" onClick={click}>Go</button>)
    keys("button", "Space")
    expect(log).toEqual(["click:button:0"])
  })

  it("does not click when the key down was cancelled", () => {
    testRoot.render(
      <button testId="button" onClick={click} onKeyDown={(event) => event.preventDefault()}>Go</button>,
    )
    keys("button", "Enter")
    keys("button", "Space")
    expect(log).toEqual([])
  })

  it("does not click on Space key up when the key up was cancelled", () => {
    testRoot.render(
      <button testId="button" onClick={click} onKeyUp={(event) => event.preventDefault()}>Go</button>,
    )
    keys("button", "Space")
    expect(log).toEqual([])
  })

  it("does not click on Space key up when focus moved after the key down", () => {
    testRoot.render(
      <div>
        <button testId="button" onClick={click}>One</button>
        <button testId="other" onClick={click}>Two</button>
      </div>,
    )
    down("button", "Space")
    // Focuses "other", then the key up reaches it: the press began on another button.
    up("other", "Space")
    expect(log).toEqual([])
    // A key up with no key down before it is not a press either.
    up("other", "Space")
    expect(log).toEqual([])
  })

  it("does not click for a handler that cancels the click", () => {
    let submits = 0
    testRoot.render(
      <form onSubmit={() => submits++}>
        <button testId="button" onClick={(event) => event.preventDefault()}>Go</button>
      </form>,
    )
    keys("button", "Enter")
    expect(submits).toBe(0)
  })

  it("clicks a focused a[href] on Enter and not on Space, and navigates nowhere", () => {
    testRoot.render(
      <div>
        <a testId="link" href="/there" onClick={click}>link</a>
        <a testId="bare" onClick={click}>bare</a>
      </div>,
    )
    keys("link", "Space")
    expect(log).toEqual([])
    keys("link", "Enter")
    expect(log).toEqual(["click:link:0"])
    // An a without an href or tabIndex takes no focus, so no key reaches it.
    testRoot.renderer.focusElement(idOf("bare"))
    expect(testRoot.renderer.getFocusedElementId()).not.toBe(idOf("bare"))
  })

  it("clicks a link once per Enter press and a button for every repeat of it", () => {
    testRoot.render(
      <div>
        <a testId="link" href="/there" onClick={click}>link</a>
        <button testId="button" onClick={click}>Go</button>
      </div>,
    )
    down("link", "Enter")
    down("link", "Enter", true)
    down("link", "Enter", true)
    expect(log).toEqual(["click:link:0"])
    down("button", "Enter")
    down("button", "Enter", true)
    down("button", "Enter", true)
    expect(log).toEqual(["click:link:0", "click:button:0", "click:button:0", "click:button:0"])
  })

  it("clicks a link on Enter with any modifier, the click carrying it, and a button on none of Ctrl, Alt, Cmd", () => {
    const modifiers: string[] = []
    const flags = (event) =>
      ["shift", "ctrl", "alt", "cmd"].filter((name) => event.modifiers?.[name]).join("+") || "none"
    testRoot.render(
      <div>
        <a testId="link" href="/there" onClick={(event) => modifiers.push(flags(event))}>link</a>
        <button testId="button" onClick={click}>Go</button>
      </div>,
    )
    for (const press of ["Enter", "Shift+Enter", "Control+Enter", "Alt+Enter", "Meta+Enter"]) keys("link", press)
    expect(modifiers).toEqual(["none", "shift", "ctrl", "alt", "cmd"])
    keys("button", "Control+Enter")
    keys("button", "Alt+Enter")
    keys("button", "Meta+Enter")
    expect(log).toEqual([])
  })

  describe("a Space press on a button", () => {
    let button
    let cancelKeyDown: boolean
    beforeEach(() => {
      cancelKeyDown = false
      testRoot.render(
        <div>
          <button
            testId="button"
            ref={(node) => (button = node)}
            onClick={click}
            onKeyDown={(event) => cancelKeyDown && event.preventDefault()}
          >
            Go
          </button>
          <button testId="other" onClick={click}>Other</button>
        </div>,
      )
    })

    it("is :active from the key down until the key up, which clicks", () => {
      expect(button.matches(":active")).toBe(false)
      down("button", "Space")
      expect(button.matches(":active")).toBe(true)
      down("button", "Space", true)
      expect(button.matches(":active")).toBe(true)
      expect(log).toEqual([])
      up("button", "Space")
      expect(button.matches(":active")).toBe(false)
      expect(log).toEqual(["click:button:0"])
    })

    it("is over when a later Space key down is cancelled: its key up clicks nothing", () => {
      down("button", "Space")
      cancelKeyDown = true
      down("button", "Space")
      expect(button.matches(":active")).toBe(false)
      cancelKeyDown = false
      up("button", "Space")
      expect(log).toEqual([])
    })

    it("is over when the button loses focus, even if it has focus again at the key up", () => {
      down("button", "Space")
      testRoot.renderer.focusElement(idOf("other"))
      expect(button.matches(":active")).toBe(false)
      up("button", "Space")
      expect(log).toEqual([])
    })

    it("is not :active for a key down a handler cancelled", () => {
      cancelKeyDown = true
      down("button", "Space")
      expect(button.matches(":active")).toBe(false)
      cancelKeyDown = false
      up("button", "Space")
      expect(log).toEqual([])
    })
  })

  it("gives a disabled button no click from the pointer, the keyboard or click()", () => {
    testRoot.render(
      <div>
        <button testId="button" disabled onClick={click} style={{ width: 80, height: 30 }}>Go</button>
      </div>,
    )
    const bounds = testRoot.renderer.getElementBounds(idOf("button"))
    testRoot.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    keys("button", "Enter")
    keys("button", "Space")
    testRoot.renderer.clickElement(idOf("button"))
    expect(log).toEqual([])
  })

  it("clicks a button by the pointer, which bubbles to a parent", () => {
    testRoot.render(
      <div onClick={() => log.push("parent")}>
        <button testId="button" onClick={click} style={{ width: 80, height: 30 }}>Go</button>
      </div>,
    )
    const bounds = testRoot.renderer.getElementBounds(idOf("button"))
    testRoot.renderer.nativeSimulateClick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    expect(log).toEqual(["click:button:1", "parent"])
  })

  it("does not click a div with tabIndex for Enter or Space: only the tags do", () => {
    testRoot.render(<div testId="stop" tabIndex={0} onClick={click}>stop</div>)
    keys("stop", "Enter")
    keys("stop", "Space")
    expect(log).toEqual([])
  })
})

describeNative("a button in a form", () => {
  let testRoot: TestRoot
  let submits: Array<{ entries: string[][]; submitter: unknown }>
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 400 })
    submits = []
  })

  const idOf = (testId: string) => testRoot.renderer.findByTestId(testId).id
  const keys = (testId: string, keystrokes: string) => testRoot.renderer.nativeSimulateKeystrokes(idOf(testId), keystrokes)
  const onSubmit = (event) => submits.push({ entries: Array.from(event.formData.entries()), submitter: event.submitter })
  const field = { width: 100, height: 24 }
  const submitterName = (submit: { submitter: { props: { testId?: string } } | null }) => submit.submitter?.props.testId ?? null

  it("submits with the button as the submitter on a pointer click, Enter and Space", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <input testId="field" name="q" value="x" onChange={() => {}} style={field} />
        <button testId="go" style={{ width: 60, height: 24 }}>Go</button>
      </form>,
    )
    const bounds = testRoot.renderer.getElementBounds(idOf("go"))
    testRoot.renderer.nativeSimulateClick(bounds.x + 5, bounds.y + 5)
    keys("go", "Enter")
    keys("go", "Space")
    expect(submits.map((submit) => submit.entries)).toEqual([[["q", "x"]], [["q", "x"]], [["q", "x"]]])
    expect(submits.map(submitterName)).toEqual(["go", "go", "go"])
  })

  it("submits for a type of submit, and for one it does not know", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <button testId="explicit" type="submit">a</button>
        <button testId="unknown" type="wat">b</button>
      </form>,
    )
    keys("explicit", "Enter")
    keys("unknown", "Enter")
    expect(submits.map(submitterName)).toEqual(["explicit", "unknown"])
  })

  it("does nothing for type=button, and for type=reset, which gpuix does not reset", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <button testId="plain" type="button">a</button>
        <button testId="reset" type="reset">b</button>
      </form>,
    )
    keys("plain", "Enter")
    keys("reset", "Enter")
    expect(submits).toEqual([])
  })

  it("does nothing outside a form, and for a button of another form", () => {
    testRoot.render(
      <div>
        <button testId="loose">a</button>
        <form onSubmit={onSubmit}>
          <button testId="inside">b</button>
        </form>
      </div>,
    )
    keys("loose", "Enter")
    expect(submits).toEqual([])
    keys("inside", "Enter")
    expect(submits.map(submitterName)).toEqual(["inside"])
  })

  it("validates before it submits, and a disabled button does not submit", () => {
    const invalid: string[] = []
    testRoot.render(
      <form onSubmit={onSubmit}>
        <input testId="needed" name="n" required onInvalid={() => invalid.push("n")} style={field} />
        <button testId="go">Go</button>
        <button testId="off" disabled>Off</button>
      </form>,
    )
    keys("go", "Enter")
    expect(submits).toEqual([])
    expect(invalid).toEqual(["n"])
    testRoot.renderer.clickElement(idOf("off"))
    expect(invalid).toEqual(["n"])
  })

  it("does not submit when a click handler of the button cancels the click", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <button testId="go" onClick={(event) => event.preventDefault()}>Go</button>
      </form>,
    )
    keys("go", "Enter")
    expect(submits).toEqual([])
  })

  describe("implicit submission by Enter in a field", () => {
    it("clicks the default button, which is the first submit button, and it is the submitter", () => {
      const clicks: string[] = []
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" style={field} />
          <input testId="b" name="b" style={field} />
          <button testId="not" type="button" onClick={() => clicks.push("not")}>no</button>
          <button testId="first" onClick={() => clicks.push("first")}>first</button>
          <button testId="second" onClick={() => clicks.push("second")}>second</button>
        </form>,
      )
      keys("a", "Enter")
      expect(clicks).toEqual(["first"])
      expect(submits.map(submitterName)).toEqual(["first"])
    })

    it("does nothing when the default button is disabled, even with one field", () => {
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" style={field} />
          <button testId="first" disabled>first</button>
          <button testId="second">second</button>
        </form>,
      )
      keys("a", "Enter")
      expect(submits).toEqual([])
    })

    it("submits with no submitter when there is no submit button and one field", () => {
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" style={field} />
          <button testId="plain" type="button">plain</button>
        </form>,
      )
      keys("a", "Enter")
      expect(submits.map(submitterName)).toEqual([null])
    })

    it("does not submit with no submit button and two fields", () => {
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" style={field} />
          <input testId="b" name="b" style={field} />
        </form>,
      )
      keys("a", "Enter")
      expect(submits).toEqual([])
    })

    it("does not submit when a handler cancels the default button's click", () => {
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" style={field} />
          <button testId="go" onClick={(event) => event.preventDefault()}>Go</button>
        </form>,
      )
      keys("a", "Enter")
      expect(submits).toEqual([])
    })

    it("still submits two fields through a submit button, with its FormData", () => {
      testRoot.render(
        <form onSubmit={onSubmit}>
          <input testId="a" name="a" value="1" onChange={() => {}} style={field} />
          <input testId="b" name="b" value="2" onChange={() => {}} style={field} />
          <button testId="go">Go</button>
        </form>,
      )
      keys("b", "Enter")
      expect(submits).toEqual([{ entries: [["a", "1"], ["b", "2"]], submitter: expect.objectContaining({ type: "button", props: expect.objectContaining({ testId: "go" }) }) }])
    })
  })
})

describeNative("a label of a button", () => {
  let testRoot: TestRoot
  let log: string[]
  let submits: Array<{ submitter: { props: { testId?: string } } | null }>
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 400 })
    log = []
    submits = []
  })

  const idOf = (testId: string) => testRoot.renderer.findByTestId(testId).id
  const clickAt = (testId: string, dx = 5, dy = 5) => {
    const bounds = testRoot.renderer.getElementBounds(idOf(testId))
    testRoot.renderer.nativeSimulateClick(bounds.x + dx, bounds.y + dy)
  }
  const keyOf = (tree: A11yTreeDump, authorId: string) => {
    const found = Object.entries(tree.nodes ?? {}).find(([, node]) => node.aria?.author_id === authorId)
    if (!found) throw new Error(`no a11y node with author id ${authorId}`)
    return found[0]
  }
  const onClick = (name: string) => () => log.push(name)
  const onSubmit = (event) => submits.push({ submitter: event.submitter })
  const box = { width: 200, height: 30 }

  it("clicks a button with an htmlFor label, and focuses it", () => {
    testRoot.render(
      <div style={{ width: 300, height: 120 }}>
        <label htmlFor="go" testId="label" onClick={onClick("label")} style={box}>Run it</label>
        <button id="go" testId="go" onClick={onClick("button")} style={{ width: 80, height: 30 }}>Go</button>
      </div>,
    )
    clickAt("label")
    expect(log).toEqual(["label", "button"])
    expect(testRoot.renderer.getFocusedElementId()).toBe(idOf("go"))
  })

  it("clicks a wrapped button when the label's own text is clicked, and not twice for the button", () => {
    testRoot.render(
      <label testId="label" style={{ width: 300, height: 40 }}>
        <span testId="text" style={{ width: 100, height: 30 }}>Run it</span>
        <button testId="go" onClick={onClick("button")} style={{ width: 80, height: 30 }}>Go</button>
      </label>,
    )
    clickAt("text")
    expect(log).toEqual(["button"])
    clickAt("go")
    expect(log).toEqual(["button", "button"])
  })

  it("submits the form of a submit button from its label, with the button as the submitter", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <label htmlFor="go" testId="outer" style={box}>Send</label>
        <label testId="wrap" style={{ width: 300, height: 40 }}>
          <span testId="text" style={{ width: 100, height: 30 }}>Send too</span>
          <button testId="wrapped" style={{ width: 80, height: 30 }}>Go</button>
        </label>
        <button id="go" testId="go" style={{ width: 80, height: 30 }}>Go</button>
      </form>,
    )
    clickAt("outer")
    clickAt("text")
    expect(submits.map((submit) => submit.submitter?.props.testId)).toEqual(["go", "wrapped"])
  })

  it("does not submit for a button of type=button, or when a handler cancels the click on the button", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <label htmlFor="plain" testId="plain-label" style={box}>Plain</label>
        <button id="plain" type="button" style={{ width: 80, height: 30 }}>a</button>
        <label htmlFor="cancel" testId="cancel-label" style={box}>Cancel</label>
        <button id="cancel" onClick={(event) => event.preventDefault()} style={{ width: 80, height: 30 }}>b</button>
      </form>,
    )
    clickAt("plain-label")
    clickAt("cancel-label")
    expect(submits).toEqual([])
  })

  it("does not click or submit a disabled button through its label", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <label htmlFor="go" testId="outer" style={box}>Send</label>
        <button id="go" disabled onClick={onClick("button")} style={{ width: 80, height: 30 }}>Go</button>
        <label testId="wrap" style={{ width: 300, height: 40 }}>
          <span testId="text" style={{ width: 100, height: 30 }}>Send too</span>
          <button disabled onClick={onClick("wrapped")} style={{ width: 80, height: 30 }}>Go</button>
        </label>
      </form>,
    )
    clickAt("outer")
    clickAt("text")
    expect(log).toEqual([])
    expect(submits).toEqual([])
  })

  it("does not activate the control of a label for a click or Enter on a link inside it", () => {
    testRoot.render(
      <label style={{ width: 300, height: 40 }}>
        <input testId="field" onClick={onClick("field")} style={{ width: 80, height: 20 }} />
        <a testId="help" href="/help" onClick={onClick("link")} style={{ display: "block", width: 60, height: 20 }}>help</a>
      </label>,
    )
    clickAt("help")
    expect(log).toEqual(["link"])
    expect(testRoot.renderer.getFocusedElementId()).toBe(idOf("help"))
    testRoot.renderer.nativeSimulateKeystrokes(idOf("help"), "Enter")
    expect(log).toEqual(["link", "link"])
    expect(testRoot.renderer.getFocusedElementId()).toBe(idOf("help"))
  })

  it("runs only the first activation target on the path: a link inside a button does not submit", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <button testId="button" style={{ width: 120, height: 40 }}>
          <a testId="link" href="/x" onClick={onClick("link")} style={{ display: "block", width: 60, height: 20 }}>x</a>
          <span testId="text" style={{ display: "block", width: 60, height: 15 }}>y</span>
        </button>
      </form>,
    )
    clickAt("link")
    expect(log).toEqual(["link"])
    expect(submits).toEqual([])
    clickAt("text")
    expect(submits.map((submit) => submit.submitter?.props.testId)).toEqual(["button"])
  })

  it("runs only the label when it is inside a button: it focuses its field and does not submit", () => {
    testRoot.render(
      <form onSubmit={onSubmit}>
        <button testId="button" style={{ width: 120, height: 40 }}>
          <label testId="label" htmlFor="field" style={{ display: "block", width: 60, height: 20 }}>Name</label>
        </button>
        <input id="field" testId="field" style={{ width: 80, height: 20 }} />
      </form>,
    )
    clickAt("label")
    expect(submits).toEqual([])
    expect(testRoot.renderer.getFocusedElementId()).toBe(idOf("field"))
  })

  it("names the button from its label before its content", () => {
    testRoot.render(
      <div style={{ width: 300, height: 160 }}>
        <label htmlFor="go" id="go-label" style={{ height: 20 }}>Send the form</label>
        <button id="go" style={{ width: 80, height: 30 }}>Go</button>
        <label id="wrap-label" style={{ width: 300, height: 40 }}>
          Remove
          <button id="wrapped" style={{ width: 80, height: 30 }}>x</button>
        </label>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "go").labelled_by).toEqual([keyOf(tree, "go-label")])
    expect(byAuthorId(tree, "go").label).toBeUndefined()
    expect(tree.nodes?.[keyOf(tree, "go-label")]?.aria?.value).toBe("Send the form")
    const wrapped = tree.nodes?.[byAuthorId(tree, "wrapped").labelled_by?.[0] ?? ""]?.aria
    expect(wrapped?.value).toBe("Remove")
  })

  it("keeps the content as the name when the label has no text, and lets aria-label and aria-labelledby win", () => {
    testRoot.render(
      <div style={{ width: 300, height: 200 }}>
        <label htmlFor="a" style={{ height: 20 }} />
        <button id="a" style={{ width: 80, height: 30 }}>Own content</button>
        <label htmlFor="b" style={{ height: 20 }}>Label b</label>
        <button id="b" aria-label="Aria b" style={{ width: 80, height: 30 }}>Content b</button>
        <label htmlFor="c" style={{ height: 20 }}>Label c</label>
        <button id="c" aria-labelledby="other" style={{ width: 80, height: 30 }}>Content c</button>
        <div id="other" style={{ height: 20 }}>Other</div>
      </div>,
    )
    const tree = testRoot.renderer.getA11yTree()
    expect(byAuthorId(tree, "a").label).toBe("Own content")
    expect(byAuthorId(tree, "a").labelled_by).toBeUndefined()
    expect(byAuthorId(tree, "b").labelled_by).toBeUndefined()
    expect(byAuthorId(tree, "b").label).toBe("Aria b")
    expect(byAuthorId(tree, "c").labelled_by).toEqual([keyOf(tree, "other")])
  })
})

describeNative("form.requestSubmit(submitter)", () => {
  let testRoot: TestRoot
  let submits: Array<{ submitter: { props: { testId?: string } } | null }>
  const refs: Record<string, any> = {}
  const ref = (name: string) => (instance: unknown) => {
    refs[name] = instance
  }
  beforeEach(() => {
    testRoot = createTestRoot({ width: 600, height: 400 })
    submits = []
  })

  const onSubmit = (event) => submits.push({ submitter: event.submitter })
  const submitterNames = () => submits.map((submit) => submit.submitter?.props.testId ?? null)

  const renderForms = () =>
    testRoot.render(
      <div>
        <form ref={ref("form")} onSubmit={onSubmit}>
          <button ref={ref("submit")} testId="submit">a</button>
          <button ref={ref("disabled")} testId="disabled" disabled>b</button>
          <button ref={ref("plain")} type="button" testId="plain">c</button>
          <div ref={ref("div")}>d</div>
        </form>
        <form onSubmit={onSubmit}>
          <button ref={ref("other")} testId="other">e</button>
        </form>
      </div>,
    )

  it("submits with the given submit button as the submitter, and with none by default", () => {
    renderForms()
    refs.form.requestSubmit()
    refs.form.requestSubmit(null)
    refs.form.requestSubmit(refs.submit)
    expect(submitterNames()).toEqual([null, null, "submit"])
  })

  it("takes a disabled submit button as the submitter, as the DOM does", () => {
    renderForms()
    refs.form.requestSubmit(refs.disabled)
    expect(submitterNames()).toEqual(["disabled"])
  })

  it("throws a TypeError for an element that is not a submit button, and submits nothing", () => {
    renderForms()
    for (const notSubmitter of [refs.plain, refs.div, refs.form, {}, "submit", 3]) {
      expect(() => refs.form.requestSubmit(notSubmitter)).toThrow(TypeError)
    }
    expect(submits).toEqual([])
  })

  it("throws a NotFoundError for a submit button of another form, and submits nothing", () => {
    renderForms()
    let thrown: unknown
    try {
      refs.form.requestSubmit(refs.other)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(DOMException)
    expect((thrown as DOMException).name).toBe("NotFoundError")
    expect(submits).toEqual([])
  })

  it("validates before it submits with a submitter", () => {
    const invalid: string[] = []
    testRoot.render(
      <form ref={ref("form")} onSubmit={onSubmit}>
        <input name="n" required onInvalid={() => invalid.push("n")} style={{ width: 100, height: 24 }} />
        <button ref={ref("submit")} testId="submit">a</button>
      </form>,
    )
    refs.form.requestSubmit(refs.submit)
    expect(invalid).toEqual(["n"])
    expect(submits).toEqual([])
  })
})

describeNative("HTML tags as DOM elements", () => {
  it("are HTMLElements with the DOM's names, attributes and user agent computed style", () => {
    const refs: Record<string, any> = {}
    const ref = (name: string) => (instance: unknown) => {
      refs[name] = instance
    }
    const testRoot = createTestRoot({ width: 600, height: 400 })
    testRoot.render(
      <div>
        <a ref={ref("a")} href="/there">link</a>
        <button ref={ref("button")} type="submit" disabled>go</button>
        <h1 ref={ref("h1")}>title</h1>
      </div>,
    )
    expect(refs.a).toBeInstanceOf(HTMLElement)
    expect([refs.a.tagName, refs.a.nodeName, refs.a.localName]).toEqual(["A", "A", "a"])
    expect(refs.button.tagName).toBe("BUTTON")
    expect(refs.a.getAttribute("href")).toBe("/there")
    expect(refs.button.getAttributeNames().sort()).toEqual(["disabled", "type"])
    expect(getComputedStyle(refs.a).getPropertyValue("display")).toBe("inline")
    expect(getComputedStyle(refs.h1).getPropertyValue("font-size")).toBe("32px")
  })
})
