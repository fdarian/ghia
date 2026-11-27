/// An `<a>` with an `href` is a link: Chrome's blue, underlined, pointer-cursor style (`a:-webkit-any-link`, and the
/// active colour while pressed), in the colour scheme of the element; a click on one to another origin is a request to
/// the system's handler, which the test renderer records and never makes.
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { getComputedStyle } from "@ghia/native/host"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("links in Solid", () => {
  let app: ReturnType<typeof createTestRoot>

  beforeEach(() => {
    app = createTestRoot({ width: 800, height: 600 })
  })

  afterEach(() => {
    app.unmount()
  })

  const center = (testId: string) => {
    const bounds = app.renderer.getElementBounds(app.renderer.findByTestId(testId)!.id)!
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  }

  /** The style the cascade produced for the element, which has the decoration and the cursor `getComputedStyle` does not list. */
  const styleOf = (testId: string) => app.renderer.getElement(app.renderer.findByTestId(testId)!.id).style

  const click = (testId: string) => {
    const at = center(testId)
    app.renderer.nativeSimulateMouseDown(at.x, at.y)
    app.renderer.nativeSimulateMouseUp(at.x, at.y)
  }

  describe("the style", () => {
    it("is Chrome's link style for an a with an href, and nothing for an a without one", () => {
      let link!: Element
      let plain!: Element
      app.render(() => (
        <div style={{ color: "#112233" }}>
          <a testId="link" ref={(element: unknown) => (link = element as Element)} href="/page">link</a>
          <a testId="plain" ref={(element: unknown) => (plain = element as Element)}>anchor</a>
        </div>
      ))
      expect(getComputedStyle(link).color).toBe("rgb(0, 0, 238)")
      expect([styleOf("link").textDecorationLine, styleOf("link").cursor]).toEqual(["underline", "pointer"])
      expect(getComputedStyle(plain).color).toBe("rgb(17, 34, 51)")
      expect([styleOf("plain").textDecorationLine ?? null, styleOf("plain").cursor ?? null]).toEqual([null, null])
    })

    it("follows the colour scheme of the element", () => {
      let light!: Element
      let dark!: Element
      app.render(() => (
        <div>
          <a ref={(element: unknown) => (light = element as Element)} href="#a">a</a>
          <div style={{ colorScheme: "dark" }}>
            <a ref={(element: unknown) => (dark = element as Element)} href="#b">b</a>
          </div>
        </div>
      ))
      expect(getComputedStyle(light).color).toBe("rgb(0, 0, 238)")
      expect(getComputedStyle(dark).color).toBe("rgb(158, 158, 255)")
    })

    it("comes and goes with the href", () => {
      let link!: Element
      app.render(() => (
        <a testId="link" ref={(element: unknown) => (link = element as Element)} href="#a">a</a>
      ))
      expect(getComputedStyle(link).color).toBe("rgb(0, 0, 238)")
      link.removeAttribute("href")
      app.renderer.flush()
      expect(styleOf("link").textDecorationLine ?? null).toBeNull()
      expect(getComputedStyle(link).color).not.toBe("rgb(0, 0, 238)")
      link.setAttribute("href", "#b")
      app.renderer.flush()
      expect(styleOf("link").textDecorationLine).toBe("underline")
    })

    it("is under a sheet rule and an own style, which win", () => {
      let ruled!: Element
      let own!: Element
      app.render(() => (
        <div>
          <style>{`.ruled { color: green; text-decoration-line: none }`}</style>
          <a testId="ruled" ref={(element: unknown) => (ruled = element as Element)} class="ruled" href="#a">a</a>
          <a testId="own" ref={(element: unknown) => (own = element as Element)} href="#b" style={{ color: "red", cursor: "default" }}>b</a>
        </div>
      ))
      expect(getComputedStyle(ruled).color).toBe("rgb(0, 128, 0)")
      expect(styleOf("ruled").textDecorationLine).toBe("none")
      expect(getComputedStyle(own).color).toBe("rgb(255, 0, 0)")
      expect(styleOf("own").cursor).toBe("default")
    })

    it("is red while pressed, and an own colour still wins", () => {
      let pressed!: Element
      let styled!: Element
      app.render(() => (
        <div style={{ fontSize: 20 }}>
          <a testId="pressed" ref={(element: unknown) => (pressed = element as Element)} href="#a">press me</a>
          <br />
          <a testId="styled" ref={(element: unknown) => (styled = element as Element)} href="#b" style={{ color: "blue" }}>styled</a>
        </div>
      ))
      const at = center("pressed")
      app.renderer.nativeSimulateMouseDown(at.x, at.y)
      expect(getComputedStyle(pressed).color).toBe("rgb(255, 0, 0)")
      app.renderer.nativeSimulateMouseUp(at.x, at.y)
      app.renderer.flush()
      expect(getComputedStyle(pressed).color).toBe("rgb(0, 0, 238)")
      const other = center("styled")
      app.renderer.nativeSimulateMouseDown(other.x, other.y)
      expect(getComputedStyle(styled).color).toBe("rgb(0, 0, 255)")
      app.renderer.nativeSimulateMouseUp(other.x, other.y)
    })
  })

  describe("a click", () => {
    it("on a link to another origin asks the system to open it, once", () => {
      app.render(() => (
        <div style={{ fontSize: 20 }}>
          <a testId="web" href="https://example.com/docs?a=1#b">web</a>
          <br />
          <a testId="mail" href="mailto:hello@example.com">mail</a>
        </div>
      ))
      click("web")
      expect(app.renderer.openedUrls()).toEqual(["https://example.com/docs?a=1#b"])
      click("mail")
      expect(app.renderer.openedUrls()).toEqual(["https://example.com/docs?a=1#b", "mailto:hello@example.com"])
    })

    it("opens nothing for a same-origin path, a fragment, javascript:, a canceled click or a download", () => {
      app.render(() => (
        <div style={{ fontSize: 20 }}>
          <a testId="path" href="/settings">path</a>
          <br />
          <a testId="fragment" href="#top">fragment</a>
          <br />
          <a testId="script" href="javascript:void(0)">script</a>
          <br />
          <a testId="canceled" href="https://example.com/x" onClick={(event: Event) => event.preventDefault()}>canceled</a>
          <br />
          <a testId="download" href="https://example.com/file.zip" download="file.zip">download</a>
        </div>
      ))
      for (const id of ["path", "fragment", "script", "canceled", "download"]) click(id)
      expect(app.renderer.openedUrls()).toEqual([])
    })
  })
})
