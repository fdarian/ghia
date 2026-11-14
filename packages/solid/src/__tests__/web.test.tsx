/**
 * `@ghia/solid/web`: the renderer-independent part of `solid-js/web` that Solid libraries import (`Dynamic`,
 * `Portal`, `isServer`), on Ghia's universal renderer.
 */
import { createSignal, type JSX } from "solid-js"
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer, type TestRoot } from "../testing.js"
import { WEB_EXPORTS } from "../web-exports.js"
import * as web from "../web.js"
import { Dynamic, Portal, isDev, isServer } from "../web.js"

describe("@ghia/solid/web exports", () => {
  it("are the names the Solid plugin allows an import from solid-js/web", () => {
    const missing = Object.keys(web).filter((name) => !WEB_EXPORTS.includes(name))
    expect(missing).toEqual([])
  })

  it("has no DOM renderer members", () => {
    for (const name of ["template", "delegateEvents", "setAttribute", "className", "classList", "style", "addEventListener", "hydrate", "ssr"]) {
      expect(name in web).toBe(false)
    }
    expect(isServer).toBe(false)
    expect(isDev).toBe(false)
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

    it("removes the container when its parent Show closes", () => {
      const [open, setOpen] = createSignal(true)
      mount(() => <>{open() && <Portal><p>in</p></Portal>}</>)
      expect(bodyTags()).toEqual(["div"])
      app!.flushSync(() => setOpen(false))
      expect(bodyTags()).toEqual([])
    })
  })
})
