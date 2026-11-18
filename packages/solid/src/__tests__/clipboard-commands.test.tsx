/// Cmd+C, Cmd+X, Cmd+V, Cmd+A and the Edit menu: the DOM clipboard event, Chrome's default copy, and the painted-text fallback. The test window has its own clipboard.
import { afterEach, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import type { JSX } from "solid-js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("the clipboard commands (Solid)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    document.getSelection().collapse(null)
    for (const cleanup of cleanups.splice(0)) cleanup()
  })

  function mount(ui: () => JSX.Element) {
    const root = createTestRoot({ width: 600, height: 400 })
    cleanups.push(() => root.unmount())
    root.render(ui)
    return root
  }

  /** Two paragraphs in an editing host, a plain paragraph and a button. Focus is on nothing. */
  function page() {
    const root = mount(() => (
      <div style={{ padding: 20, fontSize: 16 }}>
        <div id="host" contenteditable>
          <p>one two</p>
          <p>three four</p>
        </div>
        <p id="plain">plain text</p>
        <button id="button">button</button>
      </div>
    ))
    const host = document.body!.querySelector("#host") as HTMLElement
    const [one, three] = [...host.querySelectorAll("p")].map((p) => p.firstChild as Text)
    return {
      root,
      renderer: root.renderer,
      host,
      one: one!,
      three: three!,
      plain: document.body!.querySelector("#plain") as HTMLElement,
      button: document.body!.querySelector("#button") as HTMLElement,
    }
  }

  /** Records each event of `type`; with `probe` it also tries to write to `clipboardData`, which a non-cancelled event discards. */
  const copyEvents = (target: EventTarget, type = "copy", probe = false) => {
    const seen: Array<{ target: unknown; mode: string; types: string[] }> = []
    const listener = (event: Event) => {
      const data = (event as ClipboardEvent).clipboardData!
      if (probe) data.setData("text/x-probe", "p")
      seen.push({ target: event.target, mode: probe ? (data.getData("text/x-probe") === "p" ? "writable" : "not writable") : "", types: [...data.types] })
    }
    target.addEventListener(type, listener)
    cleanups.push(() => target.removeEventListener(type, listener))
    return seen
  }

  describe("copy", () => {
    it("fires at the focused editing host with a writable clipboardData, and copies the range as text and markup", () => {
      const { renderer, host, one, three } = page()
      host.focus()
      document.getSelection().setBaseAndExtent(one, 4, three, 5)
      const seen = copyEvents(document, "copy", true)
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen).toEqual([{ target: host, mode: "writable", types: ["text/x-probe"] }])
      expect(renderer.readClipboard()).toEqual([
        { type: "text/plain", data: "twothree" },
        { type: "text/html", data: "<meta charset='utf-8'><p>two</p><p>three</p>" },
      ])
    })

    it("hands the handler a protected clipboardData once the event is done", () => {
      const { renderer, host, one } = page()
      host.focus()
      document.getSelection().setBaseAndExtent(one, 0, one, 3)
      let kept!: DataTransfer
      host.addEventListener("copy", (event) => {
        kept = (event as ClipboardEvent).clipboardData!
        kept.setData("text/plain", "inside")
      })
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(kept.getData("text/plain")).toBe("")
      kept.setData("text/plain", "after")
      expect(kept.types).toEqual(["text/plain"])
      // Not canceled: the default copy, not what the handler put in.
      expect(renderer.readClipboard()[0]).toEqual({ type: "text/plain", data: "one" })
    })

    it("a canceled event leaves the clipboard exactly what the handler put in clipboardData", () => {
      const { renderer, host, one } = page()
      renderer.writeClipboard([{ type: "text/plain", data: "before" }])
      host.focus()
      document.getSelection().setBaseAndExtent(one, 0, one, 3)
      host.addEventListener("copy", (event) => {
        event.preventDefault()
        ;(event as ClipboardEvent).clipboardData!.setData("application/x-custom", "payload")
      })
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(renderer.readClipboard()).toEqual([{ type: "application/x-custom", data: "payload" }])
    })

    it("a canceled event that wrote nothing leaves the clipboard, and one that cleared the data empties it", () => {
      const { renderer, host, one } = page()
      renderer.writeClipboard([{ type: "text/plain", data: "before" }])
      host.focus()
      document.getSelection().setBaseAndExtent(one, 0, one, 3)
      let clear = false
      host.addEventListener("copy", (event) => {
        event.preventDefault()
        if (clear) (event as ClipboardEvent).clipboardData!.clearData()
      })
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "before" }])
      clear = true
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(renderer.readClipboard()).toEqual([])
    })

    it("a keydown that is prevented cancels the command: no copy event, and the clipboard is as it was", () => {
      const { renderer, host, one } = page()
      renderer.writeClipboard([{ type: "text/plain", data: "before" }])
      host.focus()
      document.getSelection().setBaseAndExtent(one, 0, one, 3)
      const seen = copyEvents(document)
      host.addEventListener("keydown", (event) => event.preventDefault())
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen).toEqual([])
      expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "before" }])
    })

    it("fires at the element that holds the selection when the focus is not in an editing host", () => {
      const { renderer, plain } = page()
      const text = plain.firstChild!
      document.getSelection().setBaseAndExtent(text, 0, text, 5)
      const seen = copyEvents(document)
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen.map((event) => event.target)).toEqual([plain])
      expect(renderer.readClipboard()[0]).toEqual({ type: "text/plain", data: "plain" })
    })

    it("fires at the focused element with no selection, and at the body with no focus", () => {
      const { renderer, button } = page()
      const seen = copyEvents(document)
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen.map((event) => event.target)).toEqual([document.body])
      button.focus()
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen.map((event) => event.target)).toEqual([document.body, button])
    })

    it("fires in an editing host that is a read-only one too, and copies nothing for a caret", () => {
      const { renderer, host, one } = page()
      renderer.writeClipboard([{ type: "text/plain", data: "before" }])
      host.focus()
      document.getSelection().collapse(one, 2)
      const seen = copyEvents(host)
      renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen).toHaveLength(1)
      expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "before" }])
    })

    it("copies the text a drag painted-selected when nothing else took the event", () => {
      const root = mount(() => (
        <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
          <div style={{ fontSize: 20 }}>hello world</div>
        </div>
      ))
      const seen = copyEvents(document)
      expect(root.renderer.dragSelect(21, 30, 900, 30)).toBe("hello world")
      root.renderer.dispatchNativeEvents()
      root.renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(seen).toHaveLength(1)
      expect(root.renderer.readClipboard()).toEqual([{ type: "text/plain", data: "hello world" }])
    })

    it("a canceled copy beats the painted selection", () => {
      const root = mount(() => (
        <div style={{ display: "flex", flexDirection: "column", padding: 20 }}>
          <div style={{ fontSize: 20 }}>hello world</div>
        </div>
      ))
      const mine = (event: Event) => {
        event.preventDefault()
        ;(event as ClipboardEvent).clipboardData!.setData("text/plain", "mine")
      }
      document.addEventListener("copy", mine)
      cleanups.push(() => document.removeEventListener("copy", mine))
      root.renderer.dragSelect(21, 30, 900, 30)
      root.renderer.dispatchNativeEvents()
      root.renderer.simulateKeystrokes("ControlOrMeta+c")
      expect(root.renderer.readClipboard()).toEqual([{ type: "text/plain", data: "mine" }])
    })

    it("an <input> keeps its own copy, with no clipboard event", () => {
      const root = mount(() => <input value="field text" style={{ width: 200, height: 30 }} />)
      const input = root.renderer.findByType("input")[0]!
      const seen = copyEvents(document)
      root.renderer.nativeSimulateKeyDown(input.id, "ControlOrMeta+a")
      root.renderer.nativeSimulateKeyDown(input.id, "ControlOrMeta+c")
      expect(seen).toEqual([])
      expect(root.renderer.readClipboard()).toEqual([{ type: "text/plain", data: "field text" }])
    })
  })

  describe("paste and cut", () => {
    it("paste fires with the clipboard's types readable, and a canceled one is done", () => {
      const { renderer, host, one } = page()
      renderer.writeClipboard([
        { type: "text/plain", data: "pasted" },
        { type: "text/html", data: "<b>pasted</b>" },
        { type: "application/x-custom", data: "c" },
      ])
      host.focus()
      document.getSelection().collapse(one, 0)
      const seen: Array<{ target: unknown; types: string[]; plain: string; html: string; custom: string; written: boolean }> = []
      host.addEventListener("paste", (event) => {
        const data = (event as ClipboardEvent).clipboardData!
        data.setData("text/plain", "written")
        seen.push({
          target: event.target,
          types: [...data.types],
          plain: data.getData("text/plain"),
          html: data.getData("text/html"),
          custom: data.getData("application/x-custom"),
          written: data.getData("text/plain") === "written",
        })
        event.preventDefault()
      })
      renderer.simulateKeystrokes("ControlOrMeta+v")
      expect(seen).toEqual([
        {
          target: host,
          types: ["text/plain", "text/html", "application/x-custom"],
          plain: "pasted",
          html: "<b>pasted</b>",
          custom: "c",
          written: false,
        },
      ])
      expect(renderer.readClipboard()).toHaveLength(3)
    })

    it("cut fires with a writable clipboardData, and a canceled one writes it", () => {
      const { renderer, host, one } = page()
      host.focus()
      document.getSelection().setBaseAndExtent(one, 0, one, 3)
      const seen = copyEvents(host, "cut")
      host.addEventListener("cut", (event) => {
        event.preventDefault()
        ;(event as ClipboardEvent).clipboardData!.setData("text/plain", "cut data")
      })
      renderer.simulateKeystrokes("ControlOrMeta+x")
      expect(seen).toHaveLength(1)
      expect(renderer.readClipboard()).toEqual([{ type: "text/plain", data: "cut data" }])
      expect(one.data).toBe("one two")
    })
  })

  describe("the Edit menu", () => {
    it("Copy runs the same command, and is enabled with nothing focused", () => {
      const { renderer, plain } = page()
      const text = plain.firstChild!
      document.getSelection().setBaseAndExtent(text, 6, text, 10)
      const seen = copyEvents(document)
      expect(renderer.simulateMenuAction("copy")).toBe(true)
      expect(seen.map((event) => event.target)).toEqual([plain])
      expect(renderer.readClipboard()[0]).toEqual({ type: "text/plain", data: "text" })
    })

    it("Paste, Cut and Select All are enabled too", () => {
      const { renderer } = page()
      const pastes = copyEvents(document, "paste")
      const cuts = copyEvents(document, "cut")
      expect(renderer.simulateMenuAction("paste")).toBe(true)
      expect(renderer.simulateMenuAction("cut")).toBe(true)
      expect(renderer.simulateMenuAction("selectAll")).toBe(true)
      expect([pastes.length, cuts.length]).toEqual([1, 1])
    })
  })

  describe("Select All", () => {
    it("selects the contents of the focused editing host, and no more", () => {
      const { renderer, host } = page()
      host.focus()
      renderer.simulateKeystrokes("ControlOrMeta+a")
      expect(document.getSelection().toString()).toBe("one twothree four")
      document.getSelection().collapse(null)
      host.focus()
      renderer.simulateMenuAction("selectAll")
      const selection = document.getSelection()
      expect([selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]).toEqual([host, 0, host, 2])
    })

    it("selects the contents of the body when no editing host has focus", () => {
      const { renderer, button } = page()
      button.focus()
      renderer.simulateKeystrokes("ControlOrMeta+a")
      const selection = document.getSelection()
      expect(selection.anchorNode).toBe(document.body)
      expect(selection.toString()).toContain("plain text")
      expect(selection.toString()).toContain("one two")
    })
  })
})
