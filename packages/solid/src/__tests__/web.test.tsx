/**
 * `@ghia/solid/web`: the renderer-independent part of `solid-js/web` that Solid libraries import (`Dynamic`,
 * `Portal`, `isServer`), on Ghia's universal renderer.
 */
import { DEV, Show, createContext, createEffect, createSignal, getOwner, onCleanup, onMount, useContext, type JSX } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"
import { WEB_EXPORTS } from "../web-exports.js"
import * as web from "../web.js"
import { Dynamic, Portal, isDev, isServer, render, spread } from "../web.js"

describe("@ghia/solid/web exports", () => {
  it("are exactly the names the Solid plugin allows an import from solid-js/web", () => {
    expect(Object.keys(web).sort()).toEqual([...WEB_EXPORTS].sort())
  })

  it("has no DOM renderer members", () => {
    for (const name of ["template", "setAttribute", "setAttributeNS", "className", "classList", "style", "addEventListener", "setProperty", "assign", "innerHTML", "DelegatedEvents", "getNextElement"]) {
      expect(name in web).toBe(false)
    }
    expect(isServer).toBe(false)
  })

  it("isDev follows the solid-js build that is loaded", () => {
    expect(isDev).toBe(DEV !== undefined)
    // vitest resolves the `development` condition, so `solid-js` is its dev build here.
    expect(isDev).toBe(true)
  })
})

describe("the server-only API, as solid-js/web's browser build has it", () => {
  it("answers with nothing where there is no server", () => {
    expect(web.getRequestEvent()).toBeUndefined()
    expect(web.useAssets()).toBeUndefined()
    expect(web.generateHydrationScript()).toBeUndefined()
    expect(web.escape("<")).toBeUndefined()
    expect(web.ssr()).toBeUndefined()
    expect(typeof web.RequestContext).toBe("symbol")
  })

  it("NoHydration and Hydration render their children", () => {
    expect(web.NoHydration({ children: "a" })).toBe("a")
    expect(web.Hydration({ children: "b" })).toBe("b")
  })

  it("renderToString and its siblings report an error and return undefined", () => {
    const logged: string[] = []
    const original = console.error
    console.error = (error: unknown) => logged.push((error as Error).message)
    try {
      expect(web.renderToString(() => null)).toBeUndefined()
      expect(web.renderToStringAsync(() => null)).toBeUndefined()
      expect(web.renderToStream(() => null)).toBeUndefined()
    } finally {
      console.error = original
    }
    expect(logged).toEqual([
      "renderToString is not supported in the browser, returning undefined",
      "renderToStringAsync is not supported in the browser, returning undefined",
      "renderToStream is not supported in the browser, returning undefined",
    ])
  })

  it("delegateEvents and clearDelegatedEvents set nothing up, and hydrate says there is nothing to hydrate", () => {
    expect(web.delegateEvents(["click"])).toBeUndefined()
    expect(web.clearDelegatedEvents()).toBeUndefined()
    expect(() => web.hydrate(() => null, {})).toThrow("no server-rendered DOM")
  })
})

describe.skipIf(!hasNativeTestRenderer)("Dynamic and Portal in Solid", () => {
  let app: TestRoot | undefined

  afterEach(() => {
    app?.unmount()
    app = undefined
  })

  function mount(ui: () => JSX.Element): TestRoot {
    app = createTestRoot({ width: 400, height: 300 })
    app.render(ui)
    return app
  }

  const bodyTags = () => [...document.body.children].map((child) => child.tagName.toLowerCase())

  describe("render and spread, with solid-js/web's signatures", () => {
    it("render(code, element) mounts into that element and returns the dispose", () => {
      let host: HTMLElement | undefined
      mount(() => <section ref={(el: unknown) => (host = el as HTMLElement)} />)
      const dispose = render(() => <p>inside</p>, host!)
      expect([...host!.children].map((child) => child.tagName)).toEqual(["P"])
      expect(bodyTags()).toEqual(["section"])
      dispose()
      expect(host!.children.length).toBe(0)
    })

    it("render into an element with children keeps them while the code's own nodes come and go", () => {
      const [open, setOpen] = createSignal(true)
      let host: HTMLElement | undefined
      mount(() => (
        <section ref={(el: unknown) => (host = el as HTMLElement)}>
          <p>app</p>
        </section>
      ))
      const dispose = render(() => <Show when={open()}><b>toast</b></Show>, host!)
      const tags = () => [...host!.children].map((child) => child.tagName)
      expect(tags()).toEqual(["P", "B"])
      app!.flushSync(() => setOpen(false))
      expect(tags()).toEqual(["P"])
      app!.flushSync(() => setOpen(true))
      expect(tags()).toEqual(["P", "B"])
      dispose()
      expect(host!.children.length).toBe(0)
    })

    it("render into document runs the code under a root without inserting what it returns", () => {
      mount(() => <section />)
      let disposed = false
      const dispose = render(() => {
        onCleanup(() => (disposed = true))
        return <b>never mounted</b>
      }, document as unknown as Document)
      expect(bodyTags()).toEqual(["section"])
      dispose()
      expect(disposed).toBe(true)
    })

    it("render runs under the owner it is given", () => {
      let seen: string | undefined
      const Context = createContext("outer")
      mount(() => (
        <Context.Provider value="inner">
          {(() => {
            const owner = getOwner()
            const host = document.createElement("div") as unknown as HTMLElement
            render(() => (seen = useContext(Context)), host, undefined, { owner })
            return host as unknown as JSX.Element
          })()}
        </Context.Provider>
      ))
      expect(seen).toBe("inner")
    })

    it("render says so for a node that is not an element of this document", () => {
      expect(() => render(() => null, {} as unknown as Element)).toThrow("into an element of this window's document")
    })

    it("spread(node, props, isSVG, skipChildren) sets the props and the children, and skipChildren leaves the children out", () => {
      let both: HTMLElement | undefined
      let bare: HTMLElement | undefined
      mount(() => {
        both = document.createElement("div") as HTMLElement
        bare = document.createElement("div") as HTMLElement
        spread(both, { id: "a", children: "kids" }, false)
        spread(bare, { id: "b", children: "kids" }, false, true)
        return [both, bare] as unknown as JSX.Element
      })
      expect(both!.getAttribute("id")).toBe("a")
      expect(both!.textContent).toBe("kids")
      expect(bare!.getAttribute("id")).toBe("b")
      expect(bare!.textContent).toBe("")
    })

    it("spread returns the props it wrote", () => {
      mount(() => {
        const node = document.createElement("div") as HTMLElement
        expect(spread(node, { id: "a", title: "t" }, false)).toEqual({ id: "a", title: "t" })
        return node as unknown as JSX.Element
      })
    })
  })

  describe("Dynamic", () => {
    it("renders a string component as a host element with the props and the children", () => {
      let element: HTMLElement | undefined
      mount(() => (
        <Dynamic component="section" id="s" ref={(el: unknown) => (element = el as HTMLElement)}>
          hello
        </Dynamic>
      ))
      expect(element!.tagName).toBe("SECTION")
      expect(element!.getAttribute("id")).toBe("s")
      expect(app!.renderer.getAllText().join("")).toBe("hello")
    })

    it("renders a function component with the other props, and swaps when the component changes", () => {
      const [component, setComponent] = createSignal<"p" | ((props: { label: string }) => JSX.Element)>("p")
      mount(() => <Dynamic component={component()} label="L">text</Dynamic>)
      expect(bodyTags()).toEqual(["p"])
      app!.flushSync(() => setComponent(() => (props: { label: string }) => <article>{props.label}</article>))
      expect(bodyTags()).toEqual(["article"])
      expect(app!.renderer.getAllText().join("")).toBe("L")
    })

    it("renders nothing for an undefined component", () => {
      mount(() => <Dynamic component={undefined} />)
      expect(bodyTags()).toEqual([])
    })

    it("keeps reactive props reactive", () => {
      const [label, setLabel] = createSignal("a")
      mount(() => <Dynamic component="span" aria-label={label()} />)
      const span = document.body.children[0]!
      expect(span.getAttribute("aria-label")).toBe("a")
      app!.flushSync(() => setLabel("b"))
      expect(span.getAttribute("aria-label")).toBe("b")
    })
  })

  describe("Portal", () => {
    it("appends its children in a container under document.body, and removes the container on dispose", () => {
      let container: HTMLElement | undefined
      mount(() => (
        <main>
          <Portal ref={(el) => (container = el)}>
            <aside>overlay</aside>
          </Portal>
        </main>
      ))
      expect(bodyTags()).toEqual(["main", "div"])
      expect(container).toBe(document.body.children[1])
      expect([...container!.children].map((child) => child.tagName)).toEqual(["ASIDE"])
      expect(document.body.children[0]!.textContent).toBe("")
      expect(app!.renderer.getAllText().join("")).toBe("overlay")

      app!.unmount()
      expect(document.body.children.length).toBe(0)
      app = undefined
    })

    it("mounts in the element given as mount, and follows its content", () => {
      const [shown, setShown] = createSignal(true)
      let target: HTMLElement | undefined
      mount(() => (
        <>
          <section ref={(el) => (target = el as unknown as HTMLElement)} />
          <Portal mount={target}>{shown() ? <b>x</b> : <i>y</i>}</Portal>
        </>
      ))
      expect([...target!.children].map((child) => child.tagName)).toEqual(["DIV"])
      expect(target!.children[0]!.children[0]!.tagName).toBe("B")
      app!.flushSync(() => setShown(false))
      expect(target!.children[0]!.children[0]!.tagName).toBe("I")
    })

    it("has its content in place before a sibling's onMount and createEffect run", () => {
      const seen: Array<string | undefined> = []
      mount(() => {
        onMount(() => seen.push(document.querySelector("aside#overlay")?.tagName))
        createEffect(() => seen.push(document.querySelector("aside#overlay")?.tagName))
        return (
          <>
            <Portal>
              <aside id="overlay" />
            </Portal>
            <main />
          </>
        )
      })
      expect(seen).toEqual(["ASIDE", "ASIDE"])
    })

    it("removes the container when its parent Show closes", () => {
      const [open, setOpen] = createSignal(true)
      mount(() => <>{open() && <Portal><p>in</p></Portal>}</>)
      expect(bodyTags()).toEqual(["div"])
      app!.flushSync(() => setOpen(false))
      expect(bodyTags()).toEqual([])
    })
  })
})
