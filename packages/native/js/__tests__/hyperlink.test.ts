import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DOM_BINDING, HTMLElement, Text, type ElementBinding, type Node, type TextBinding } from "../dom/nodes.js"
import { defineDomMembers } from "../dom-members.js"
import { followLinkOnClick, clickActivatesLink } from "../events/link-activation.js"
import { followLinkAfterClick } from "../events/activation.js"
import { MouseEvent } from "../events/classes.js"
import "../dom-globals.js"

class FakeEl extends HTMLElement {
  parent: FakeEl | null = null
  readonly kids: Array<FakeEl | FakeText> = []
  readonly props = new Map<string, unknown>()
  constructor(readonly tag: string) {
    super()
  }
  [DOM_BINDING](): ElementBinding {
    return {
      parent: this.parent as Node | null,
      children: this.kids as readonly Node[],
      connected: true,
      root: null,
      type: this.tag,
      prop: (name) => this.props.get(name),
      propNames: () => this.props.keys(),
      setProp: (name, value) => {
        this.props.set(name, value)
      },
      removeProp: (name) => {
        this.props.delete(name)
      },
      style: {},
    }
  }
}

class FakeText extends Text {
  parent: FakeEl | null = null
  constructor(public text: string) {
    super()
  }
  [DOM_BINDING](): TextBinding {
    return { parent: this.parent as Node | null, children: [], connected: true, root: null, data: this.text }
  }
}

defineDomMembers(FakeEl.prototype, (element: FakeEl) => ({
  listeners: undefined as never,
  style: {},
  connected: true,
  prop: (name) => element.props.get(name),
  propNames: () => element.props.keys(),
  setProp: (name, value) => {
    element.props.set(name, value)
  },
  removeProp: (name) => {
    element.props.delete(name)
  },
}))

function link(href?: string, tag = "a"): FakeEl {
  const element = new FakeEl(tag)
  if (href !== undefined) element.props.set("href", href)
  return element
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the URL members of a link", () => {
  beforeEach(() => {
    history.pushState(null, "", "http://localhost/dir/page?q=1#top")
  })

  it("resolves href against the document URL", () => {
    expect(link("/b").href).toBe("http://localhost/b")
    expect(link("c?x=2#f").href).toBe("http://localhost/dir/c?x=2#f")
    expect(link("#frag").href).toBe("http://localhost/dir/page?q=1#frag")
    expect(link("").href).toBe("http://localhost/dir/page?q=1")
    expect(link("https://user:pw@example.com:8080/p/q?s=1#h").href).toBe("https://user:pw@example.com:8080/p/q?s=1#h")
  })

  it("reads the parts of the URL", () => {
    const anchor = link("https://user:pw@example.com:8080/p/q?s=1#h")
    expect([anchor.origin, anchor.protocol, anchor.username, anchor.password]).toEqual(["https://example.com:8080", "https:", "user", "pw"])
    expect([anchor.host, anchor.hostname, anchor.port, anchor.pathname, anchor.search, anchor.hash]).toEqual([
      "example.com:8080",
      "example.com",
      "8080",
      "/p/q",
      "?s=1",
      "#h",
    ])
    const relative = link("/b")
    expect([relative.origin, relative.host, relative.port, relative.search, relative.hash]).toEqual(["http://localhost", "localhost", "", "", ""])
  })

  it("answers the empty values for a missing attribute", () => {
    const anchor = link()
    expect(anchor.href).toBe("")
    expect([anchor.origin, anchor.username, anchor.password, anchor.host, anchor.hostname, anchor.port, anchor.pathname, anchor.search, anchor.hash]).toEqual(["", "", "", "", "", "", "", "", ""])
    expect(anchor.protocol).toBe(":")
    anchor.pathname = "/x"
    anchor.hash = "y"
    expect(anchor.getAttribute("href")).toBeNull()
  })

  it("reads back text that is not a URL as written", () => {
    const anchor = link("http://")
    expect(anchor.href).toBe("http://")
    expect([anchor.origin, anchor.pathname, anchor.protocol]).toEqual(["", "", ":"])
  })

  it("an opaque URL has no host and a path of its own", () => {
    const anchor = link("mailto:a@b.c?subject=x")
    expect([anchor.protocol, anchor.host, anchor.pathname, anchor.search, anchor.origin]).toEqual(["mailto:", "", "a@b.c", "?subject=x", "null"])
  })

  it("assigning href sets the attribute as written", () => {
    const anchor = link()
    anchor.href = "/next?a=1"
    expect(anchor.getAttribute("href")).toBe("/next?a=1")
    expect(anchor.href).toBe("http://localhost/next?a=1")
  })

  it("a setter changes the part and rewrites href as the resolved URL", () => {
    const anchor = link("/a/b?x=1#h")
    anchor.pathname = "/c d"
    expect(anchor.getAttribute("href")).toBe("http://localhost/c%20d?x=1#h")
    anchor.search = "y=2"
    expect(anchor.search).toBe("?y=2")
    anchor.hash = "#z"
    expect(anchor.hash).toBe("#z")
    anchor.hash = ""
    expect(anchor.getAttribute("href")).toBe("http://localhost/c%20d?y=2")
    anchor.port = "81"
    anchor.hostname = "example.org"
    anchor.protocol = "https"
    anchor.username = "u"
    anchor.password = "p"
    expect(anchor.href).toBe("https://u:p@example.org:81/c%20d?y=2")
    anchor.host = "example.net:9"
    expect(anchor.host).toBe("example.net:9")
    expect(anchor.origin).toBe("https://example.net:9")
  })

  it("origin is read only", () => {
    const anchor = link("/a")
    anchor.origin = "http://elsewhere"
    expect(anchor.origin).toBe("http://localhost")
  })

  it("reflects the attributes a link has", () => {
    const anchor = link("/a")
    expect([anchor.target, anchor.download, anchor.rel, anchor.hreflang, anchor.type, anchor.referrerPolicy]).toEqual(["", "", "", "", "", ""])
    anchor.target = "_blank"
    anchor.download = "f.txt"
    anchor.rel = "noopener  external"
    anchor.hreflang = "fr"
    anchor.type = "text/plain"
    anchor.referrerPolicy = "Origin"
    expect(anchor.getAttribute("target")).toBe("_blank")
    expect(anchor.getAttribute("download")).toBe("f.txt")
    expect(anchor.getAttribute("rel")).toBe("noopener  external")
    expect(anchor.getAttribute("hreflang")).toBe("fr")
    expect(anchor.getAttribute("type")).toBe("text/plain")
    expect(anchor.referrerPolicy).toBe("origin")
    anchor.referrerPolicy = "bogus"
    expect(anchor.getAttribute("referrerpolicy")).toBe("bogus")
    expect(anchor.referrerPolicy).toBe("")
  })

  it("relList is a live list of rel", () => {
    const anchor = link("/a")
    anchor.rel = "noopener"
    const list = anchor.relList
    expect(anchor.relList).toBe(list)
    expect([list.length, list.contains("noopener"), list.value]).toEqual([1, true, "noopener"])
    list.add("external")
    expect(anchor.getAttribute("rel")).toBe("noopener external")
    list.remove("noopener")
    expect(anchor.rel).toBe("external")
    expect([list.supports("noreferrer"), list.supports("nofollow")]).toEqual([true, false])
    anchor.relList = "nofollow"
    expect(anchor.getAttribute("rel")).toBe("nofollow")
    expect(anchor.getAttribute("class")).toBeNull()
  })

  it("text is the text content of an anchor", () => {
    const anchor = link("/a")
    const text = new FakeText("go")
    text.parent = anchor
    anchor.kids.push(text)
    expect(anchor.text).toBe("go")
  })

  it("an area has the URL members and the shared attributes, and a div has none", () => {
    const area = link("/map", "area")
    expect([area.href, area.pathname]).toEqual(["http://localhost/map", "/map"])
    area.target = "x"
    expect(area.getAttribute("target")).toBe("x")
    const div = new FakeEl("div")
    expect([div.href, div.pathname, div.relList, div.target]).toEqual([undefined, undefined, undefined, undefined])
    div.href = "x"
    expect(div.getAttribute("href")).toBeNull()
  })
})

describe("following a link on a click", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const heard: string[] = []
  const onHash = (event: Event) => heard.push(`${(event as HashChangeEvent).oldURL} -> ${(event as HashChangeEvent).newURL}`)

  beforeEach(() => {
    history.pushState(null, "", "http://localhost/dir/page")
    window.addEventListener("hashchange", onHash)
  })

  afterEach(() => {
    window.removeEventListener("hashchange", onHash)
    heard.length = 0
    warn.mockClear()
  })

  it("a link to a fragment of the document is a fragment navigation", async () => {
    const before = history.length
    followLinkOnClick([link("#a")])
    expect(location.href).toBe("http://localhost/dir/page#a")
    expect(history.length).toBe(before + 1)
    await tick()
    expect(heard).toEqual(["http://localhost/dir/page -> http://localhost/dir/page#a"])
    followLinkOnClick([link("page#b")])
    expect(location.hash).toBe("#b")
    followLinkOnClick([link("#")])
    expect(location.href).toBe("http://localhost/dir/page#")
    expect(warn).not.toHaveBeenCalled()
  })

  it("a click inside a link follows the nearest link on its path", () => {
    const inner = new FakeEl("span")
    followLinkOnClick([inner, link("#in"), link("#outer")])
    expect(location.hash).toBe("#in")
  })

  it("another URL goes to openLinkExternally, which warns once per URL and navigates nowhere", () => {
    followLinkOnClick([link("/b")])
    followLinkOnClick([link("/b")])
    followLinkOnClick([link("https://example.com/")])
    expect(location.href).toBe("http://localhost/dir/page")
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("http://localhost/b"),
      expect.stringContaining("https://example.com/"),
    ])
  })

  it("does nothing for a download, a link without href, or a button on the path first", () => {
    const download = link("#d")
    download.props.set("download", "")
    followLinkOnClick([download])
    followLinkOnClick([link()])
    followLinkOnClick([new FakeEl("button"), link("#c")])
    expect(location.hash).toBe("")
    expect(clickActivatesLink([new FakeEl("button"), link("#c")])).toBe(false)
    expect(clickActivatesLink([new FakeEl("span"), link("#c")])).toBe(true)
  })

  it("a click an app dispatched follows the link unless it was canceled", () => {
    const click = new MouseEvent("click", { cancelable: true })
    followLinkAfterClick([link("#x")], click)
    expect(location.hash).toBe("#x")
    const canceled = new MouseEvent("click", { cancelable: true })
    canceled.preventDefault()
    followLinkAfterClick([link("#y")], canceled)
    expect(location.hash).toBe("#x")
  })
})
