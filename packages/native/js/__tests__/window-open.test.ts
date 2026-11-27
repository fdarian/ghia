/**
 * `window.open` and the Window object it returns, on test windows: an adapter's factory makes the
 * empty root of each new window (a fixture stands in for it), and a test window is the sibling the
 * opener's renderer makes.
 */
import { afterEach, describe, expect, it } from "vitest"
import "../dom-globals.js"
import type { GpuixWindow } from "../events/window-targets.js"
import { document as globalDocument, documentOf, globalWindow, windowOf } from "../events/window-target.js"
import { TestRenderer, hasNativeTestRenderer } from "../testing.js"
import { unmountAllRoots } from "../roots.js"
import { registerWindowDisposer, windowGone } from "../window-lifecycle.js"
import { featureOptions, registerWindowFactory, tokenizeFeatures } from "../window-open.js"
import { mountEmptyRoot, Piece } from "./fixtures/piece-nodes.js"

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

/** The first window, with a root and a factory like the one `render()` of an adapter registers. */
function openFirst(title = "Parent window"): TestRenderer {
  const renderer = new TestRenderer({ width: 600, height: 400, title })
  cleanups.push(mountEmptyRoot(renderer))
  cleanups.push(registerWindowFactory(renderer, (opened) => mountEmptyRoot(opened as TestRenderer)))
  return renderer
}

const opened = (window: object | null): GpuixWindow => {
  expect(window).not.toBeNull()
  return window as GpuixWindow
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("the features string", () => {
  it("tokenizes names case-insensitively, with commas, spaces and = as separators", () => {
    expect([...tokenizeFeatures("Width=320, HEIGHT = 240 popup,noopener")]).toEqual([
      ["width", "320"],
      ["height", "240"],
      ["popup", ""],
      ["noopener", ""],
    ])
  })

  it("lowercases the values too, so NOOPENER=YES is set as noopener=yes is", () => {
    expect([...tokenizeFeatures("NoOpener=YES,Popup=TRUE")]).toEqual([
      ["noopener", "yes"],
      ["popup", "true"],
    ])
  })

  it("normalizes the aliases of the size and the place", () => {
    expect(featureOptions(tokenizeFeatures("innerWidth=300,innerHeight=200,screenX=5,screenY=6"))).toEqual({ width: 300, height: 200, x: 5, y: 6 })
    expect(featureOptions(tokenizeFeatures("width=320,height=240,left=-10,top=20,popup"))).toEqual({ width: 320, height: 240, x: -10, y: 20 })
  })

  it("places a window only when it has both coordinates, and ignores a size that is not positive", () => {
    expect(featureOptions(tokenizeFeatures("left=10,width=0,height=abc"))).toEqual({})
  })
})

describe.skipIf(!hasNativeTestRenderer)("window.open", () => {
  it("opens a window with its own empty document, sized by the features, titled like the opener", () => {
    openFirst("Parent window")
    const child = opened(window.open("", "_blank", "width=321,height=222,popup"))
    expect(child instanceof Window).toBe(true)
    expect(window instanceof Window).toBe(true)
    expect(child).not.toBe(window)
    expect([child.innerWidth, child.innerHeight]).toEqual([321, 222])
    expect((child.renderer as TestRenderer).getWindowTitle()).toBe("Parent window")
    expect([child.window, child.self, child.frames, child.parent, child.top]).toEqual([child, child, child, child, child])
    expect([child.opener, child.name, child.closed]).toEqual([window, "", false])
    expect(child.document).not.toBe(globalDocument)
    expect(child.document.defaultView).toBe(child)
    expect(child.document.documentElement.parentNode).toBe(child.document)
    expect(child.document.body).not.toBe(globalDocument.body)
  })

  it("gives the new window a live document that is separate from the opener's", () => {
    openFirst()
    const child = opened(window.open())
    const div = child.document.createElement("div")
    expect(div).toBeInstanceOf(Piece)
    child.document.body.appendChild(div)
    expect(child.document.body.contains(div)).toBe(true)
    expect(globalDocument.body.contains(div)).toBe(false)
    expect(div.ownerDocument).toBe(child.document)
    expect(div.isConnected).toBe(true)
    expect(child.document.body.children).toHaveLength(1)
    expect(globalDocument.body.children).toHaveLength(0)
  })

  it("is called from any window: the opener of the new one is the window it was called on", () => {
    openFirst()
    const second = opened(window.open())
    const third = opened(second.open("", "_blank", "width=100,height=120"))
    expect(third.opener).toBe(second)
    expect(second.opener).toBe(window)
    expect([third.innerWidth, third.innerHeight]).toEqual([100, 120])
  })

  it("reuses and focuses an open window of that name, and _blank always opens", () => {
    openFirst()
    const first = opened(window.open("", "tools"))
    expect(first.name).toBe("tools")
    const again = window.open("", "TOOLS", "width=50,height=50")
    expect(again).toBe(first)
    expect(first.innerWidth).not.toBe(50)
    const other = opened(window.open("", "_blank"))
    expect(other).not.toBe(first)
    expect(other.name).toBe("")
    expect(window.open("", "_blank")).not.toBe(other)
    first.close()
    expect(window.open("", "tools")).not.toBe(first)
  })

  it("returns null and sets no opener for noopener and noreferrer, and still opens the window", () => {
    const renderer = openFirst()
    const before = windowOf(renderer)
    expect(window.open("", "_blank", "noopener")).toBeNull()
    expect(window.open("", "named", "noreferrer,width=100")).toBeNull()
    const named = window.open("", "named")
    expect(named).not.toBeNull()
    expect((named as GpuixWindow).opener).toBeNull()
    expect(before).toBe(globalWindow())
  })

  it("returns null for noopener and noreferrer when it finds the window of that name, and still focuses it", () => {
    openFirst()
    const named = opened(window.open("", "tools"))
    const other = opened(window.open("", "other"))
    expect(window.open("", "tools", "noopener")).toBeNull()
    expect(window.open("", "Tools", "NOREFERRER=YES")).toBeNull()
    expect(window.open("", "tools", "width=10")).toBe(named)
    expect((named.renderer as TestRenderer).isWindowKey()).toBe(true)
    expect((other.renderer as TestRenderer).isWindowKey()).toBe(false)
    expect(named.opener).toBe(window)
  })

  it("gives a named window whose root is gone a fresh one from the opener's factory, instead of throwing on focus", () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    const unmounts: Array<() => void> = []
    const made: TestRenderer[] = []
    cleanups.push(
      registerWindowFactory(renderer, (target) => {
        made.push(target as TestRenderer)
        const unmount = mountEmptyRoot(target as TestRenderer)
        unmounts.push(unmount)
        return unmount
      })
    )
    const popup = opened(window.open("", "inspector"))
    expect(popup.mountedRenderer).toBeDefined()
    // `ghia dev` unmounting every root before it runs the entry again leaves the native window open.
    unmounts[0]()
    expect(popup.mountedRenderer).toBeUndefined()
    expect(popup.closed).toBe(false)
    const again = opened(window.open("", "inspector"))
    expect(again).toBe(popup)
    expect(made).toEqual([popup.renderer, popup.renderer])
    expect(popup.mountedRenderer).toBeDefined()
    expect(() => popup.document.body.appendChild(popup.document.createElement("div"))).not.toThrow()
  })

  it("does not find a named window whose renderer was disposed", () => {
    openFirst()
    const popup = opened(window.open("", "inspector"))
    ;(popup.renderer as TestRenderer).dispose()
    expect(popup.closed).toBe(true)
    const fresh = opened(window.open("", "inspector"))
    expect(fresh).not.toBe(popup)
    expect(fresh.mountedRenderer).toBeDefined()
  })

  it("closes the windows a script opened when every root is unmounted, as ghia dev does before it runs the entry again", async () => {
    openFirst()
    const popup = opened(window.open("", "inspector"))
    const unnamed = opened(window.open())
    unmountAllRoots()
    expect(popup.closed).toBe(true)
    expect(unnamed.closed).toBe(true)
    await tick()
    expect((popup.renderer as TestRenderer | undefined)?.isWindowClosed()).toBe(true)
    expect(window.open("", "inspector")).not.toBe(popup)
  })

  it("hands a link to another origin to the system and returns null", () => {
    const renderer = openFirst()
    expect(window.open("https://example.org/docs")).toBeNull()
    expect(window.open("mailto:me@example.org", "_blank")).toBeNull()
    expect(renderer.openedUrls()).toEqual(["https://example.org/docs", "mailto:me@example.org"])
  })

  it("throws NotSupportedError for a URL of this origin, which would load a document", () => {
    openFirst()
    const attempt = () => window.open("/settings")
    expect(attempt).toThrow(/no document loading/)
    expect(attempt).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    expect(() => window.open("http://localhost/other", "named")).toThrow(/window\.open\(''\)/)
  })

  it("navigates the window itself for _self, _parent and _top as location.assign does", () => {
    openFirst()
    expect(window.open("#section", "_self")).toBe(window)
    expect(location.hash).toBe("#section")
    expect(window.open("", "_top")).toBe(window)
    expect(() => window.open("/page", "_parent")).toThrow(expect.objectContaining({ name: "NotSupportedError" }))
    history.pushState(null, "", "http://localhost/")
  })

  it("throws a clear error when the renderer has no factory or no window", () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    expect(() => window.open()).toThrow(/needs a root that can make an empty root/)
  })

  it("closes the window it made when the adapter's factory throws", () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    cleanups.push(
      registerWindowFactory(renderer, () => {
        throw new Error("no root")
      })
    )
    expect(() => window.open()).toThrow("no root")
  })
})

describe.skipIf(!hasNativeTestRenderer)("closing a window", () => {
  it("sets closed at once, then fires beforeunload, pagehide and unload on that window in a later task", async () => {
    openFirst()
    const child = opened(window.open("", "_blank", "width=200,height=200"))
    const log: string[] = []
    for (const type of ["beforeunload", "pagehide", "unload"]) {
      child.addEventListener(type, (event) => log.push(`${type}:${event.target === child}:${(event as PageTransitionEvent).persisted ?? "-"}`))
    }
    window.addEventListener("unload", () => log.push("the opener heard it"), { once: true })
    child.close()
    expect(child.closed).toBe(true)
    expect(log).toEqual([])
    expect(child.document.body).toBeDefined()
    await tick()
    expect(log).toEqual(["beforeunload:true:-", "pagehide:true:false", "unload:true:-"])
    expect(window.closed).toBe(false)
    expect((child.renderer as TestRenderer).isWindowClosed()).toBe(true)
    child.close()
    await tick()
    expect(log).toHaveLength(3)
    expect(() => child.document.body).not.toThrow()
  })

  it("does not unmount the root under the handler of the window that closes itself", async () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    let unmounted = 0
    cleanups.push(
      registerWindowFactory(renderer, (target) => {
        const unmount = mountEmptyRoot(target as TestRenderer)
        return () => {
          unmounted += 1
          unmount()
        }
      })
    )
    const child = opened(window.open())
    const seen: Array<[number, boolean]> = []
    child.addEventListener("ping", () => {
      child.close()
      seen.push([unmounted, child.mountedRenderer !== undefined])
    })
    child.dispatchEvent(new Event("ping"))
    expect(seen).toEqual([[0, true]])
    expect(child.closed).toBe(true)
    await tick()
    expect(unmounted).toBe(1)
  })

  it("fires pagehide and unload, but not beforeunload, when the user closed the window", () => {
    openFirst()
    const child = opened(window.open())
    const log: string[] = []
    for (const type of ["beforeunload", "pagehide", "unload"]) child.addEventListener(type, () => log.push(type))
    // What the frame loop does when native says the window is gone.
    windowGone(child.renderer as TestRenderer)
    expect(log).toEqual(["pagehide", "unload"])
    expect(child.closed).toBe(true)
    windowGone(child.renderer as TestRenderer)
    expect(log).toHaveLength(2)
  })

  it("does not close the global window again when a close() task outlives the disposal of its renderer", async () => {
    const first = openFirst()
    expect(documentOf(first)).toBe(globalDocument)
    window.close()
    // The task of `close()` has not run: the window goes first, as a test's `dispose()` or the frame loop makes it.
    first.dispose()
    await tick()
    const next = openFirst()
    expect(documentOf(next)).toBe(globalDocument)
    expect(globalWindow().closed).toBe(false)
    expect(globalDocument.visibilityState).not.toBe("hidden")
  })

  it("lets the cancelable beforeunload of a script close go", async () => {
    openFirst()
    const child = opened(window.open())
    child.addEventListener("beforeunload", (event) => event.preventDefault())
    child.close()
    await tick()
    expect(child.closed).toBe(true)
    expect((child.renderer as TestRenderer).isWindowClosed()).toBe(true)
  })

  it("does not close the platform window a second time when the user closed it before the task ran", async () => {
    openFirst()
    const child = opened(window.open())
    const log: string[] = []
    for (const type of ["beforeunload", "pagehide", "unload"]) child.addEventListener(type, () => log.push(type))
    child.close()
    windowGone(child.renderer as TestRenderer)
    expect(log).toEqual(["pagehide", "unload"])
    await tick()
    expect(log).toEqual(["pagehide", "unload"])
  })

  it("lets go of the first window's root when that window goes, and its window hears pagehide and unload", () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    const log: string[] = []
    const stopDisposer = registerWindowDisposer(renderer, () => log.push("root unmounted"))
    cleanups.push(stopDisposer)
    for (const type of ["pagehide", "unload"]) window.addEventListener(type, () => log.push(type), { once: true })
    windowGone(renderer)
    expect(log).toEqual(["pagehide", "unload", "root unmounted"])
    windowGone(renderer)
    expect(log).toHaveLength(3)
  })

  it("does not run the disposer of a root that unmounted on its own", () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    let calls = 0
    registerWindowDisposer(renderer, () => (calls += 1))()
    windowGone(renderer)
    expect(calls).toBe(0)
  })

  it("lets go of the roots of a test window that is disposed, while its window is whole, and again for a later window under the same global window", () => {
    const first = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(first))
    const heard: string[] = []
    registerWindowDisposer(first, () => heard.push(`disposed:${globalWindow().renderer === first}`))
    window.addEventListener("pagehide", () => heard.push("pagehide"), { once: true })
    first.dispose()
    expect(heard).toEqual(["pagehide", "disposed:true"])
    const second = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(second))
    window.addEventListener("pagehide", () => heard.push("pagehide again"), { once: true })
    second.dispose()
    expect(heard).toEqual(["pagehide", "disposed:true", "pagehide again"])
  })

  it("runs what the adapter's factory returned, once, and keeps the opened windows open when the opener closes", async () => {
    const renderer = new TestRenderer({ width: 300, height: 300 })
    cleanups.push(mountEmptyRoot(renderer))
    let unmounted = 0
    cleanups.push(
      registerWindowFactory(renderer, (opened) => {
        const unmount = mountEmptyRoot(opened as TestRenderer)
        return () => {
          unmounted += 1
          unmount()
        }
      })
    )
    const child = opened(window.open())
    expect(child.opener).toBe(window)
    const grandchild = opened(child.open())
    child.close()
    await tick()
    expect(unmounted).toBe(1)
    expect(grandchild.closed).toBe(false)
    expect(grandchild.opener).toBe(child)
    grandchild.close()
    await tick()
    expect(unmounted).toBe(2)
  })

  it("sets on<event> handler properties that run once per event, with the window as this", async () => {
    openFirst()
    const child = opened(window.open())
    const heard: unknown[] = []
    child.onunload = function (this: unknown, event) {
      heard.push([this === child, event.type])
    }
    child.onunload = child.onunload
    expect(typeof child.onunload).toBe("function")
    child.close()
    await tick()
    expect(heard).toEqual([[true, "unload"]])
  })
})

describe.skipIf(!hasNativeTestRenderer)("postMessage", () => {
  it("delivers a structured clone as a MessageEvent in a later task, with the origin and the sender as source", async () => {
    openFirst()
    const child = opened(window.open())
    const received: MessageEvent[] = []
    child.addEventListener("message", (event) => received.push(event as MessageEvent))
    const message = { list: [1, 2], at: new Date(0) }
    child.postMessage(message, "*")
    expect(received).toHaveLength(0)
    await tick()
    expect(received).toHaveLength(1)
    const event = received[0]
    expect(event.type).toBe("message")
    expect(event.data).toEqual(message)
    expect(event.data).not.toBe(message)
    expect(event.origin).toBe(location.origin)
    expect(event.source).toBe(window)
    expect(event.target).toBe(child)
  })

  it("is sent to the opener too, and an onmessage handler hears it", async () => {
    openFirst()
    const child = opened(window.open())
    const received: unknown[] = []
    ;(child.opener as Window).addEventListener("message", (event) => received.push((event as MessageEvent).data), { once: true })
    ;(child.opener as Window).postMessage("hello", location.origin)
    await tick()
    expect(received).toEqual(["hello"])
    const handled: unknown[] = []
    child.onmessage = (event) => handled.push((event as MessageEvent).data)
    child.postMessage({ n: 1 })
    await tick()
    expect(handled).toEqual([{ n: 1 }])
  })

  it("drops a message addressed to another origin, and throws for what cannot be cloned", async () => {
    openFirst()
    const child = opened(window.open())
    const received: unknown[] = []
    child.addEventListener("message", (event) => received.push(event))
    child.postMessage("nope", "https://example.org")
    expect(() => child.postMessage(() => {}, "*")).toThrow(expect.objectContaining({ name: "DataCloneError" }))
    expect(() => child.postMessage("x", "not a url")).toThrow(expect.objectContaining({ name: "SyntaxError" }))
    await tick()
    expect(received).toEqual([])
  })

  it("is not delivered to a window that closed meanwhile", async () => {
    openFirst()
    const child = opened(window.open())
    const received: unknown[] = []
    child.addEventListener("message", (event) => received.push(event))
    child.postMessage("late", "*")
    child.close()
    await tick()
    expect(received).toEqual([])
  })
})

describe.skipIf(!hasNativeTestRenderer)("the members of a Window object", () => {
  it("reads devicePixelRatio and the size from the window's own renderer", () => {
    openFirst()
    const first = new TestRenderer({ width: 200, height: 200, scaleFactor: 2 })
    cleanups.push(mountEmptyRoot(first))
    const child = opened(window.open("", "_blank", "width=400,height=300"))
    expect(window.devicePixelRatio).toBe(1)
    expect(child.devicePixelRatio).toBe(1)
    const scaled = windowOf(first)
    expect(scaled.devicePixelRatio).toBe(2)
    expect([child.outerWidth, child.outerHeight]).toEqual([400, 300])
    expect([child.screenX, child.screenY, child.screenLeft, child.screenTop]).toEqual([0, 0, 0, 0])
    first.dispose()
  })

  it("resizes through the renderer", () => {
    openFirst()
    const child = opened(window.open("", "_blank", "width=400,height=300"))
    child.resizeTo(250, 260)
    expect([child.innerWidth, child.innerHeight]).toEqual([250, 260])
    child.resizeBy(10, -10)
    expect([child.innerWidth, child.innerHeight]).toEqual([260, 250])
    child.moveTo(10, 10)
    child.moveBy(1, 1)
  })

  it("has matchMedia, getComputedStyle and requestAnimationFrame of its own window, and the realm's timers and classes", async () => {
    openFirst()
    const child = opened(window.open("", "_blank", "width=480,height=300"))
    expect(child.matchMedia("(min-width: 400px)").matches).toBe(true)
    expect(child.matchMedia("(min-width: 500px)").matches).toBe(false)
    expect(window.matchMedia("(min-width: 500px)").matches).toBe(true)
    expect(typeof child.requestAnimationFrame(() => {})).toBe("number")
    expect(child.getComputedStyle).toBeTypeOf("function")
    expect(child.setTimeout).toBe(globalThis.setTimeout)
    expect(child.HTMLElement).toBe(HTMLElement)
    expect(child.Promise).toBe(Promise)
    const fired = await new Promise<boolean>((resolve) => child.setTimeout(() => resolve(true), 0))
    expect(fired).toBe(true)
    expect(child.location).toBe(location)
    expect(child.history).toBe(history)
    expect(child.localStorage).toBe(localStorage)
    expect(child.sessionStorage).toBe(sessionStorage)
  })

  it("has its own event handler properties, window event target and dispatchEvent", () => {
    openFirst()
    const child = opened(window.open())
    const heard: string[] = []
    child.addEventListener("custom", (event) => heard.push(`child:${event.target === child}:${event.currentTarget === child}`))
    window.addEventListener("custom", () => heard.push("opener"))
    expect(child.dispatchEvent(new Event("custom", { cancelable: true }))).toBe(true)
    expect(heard).toEqual(["child:true:true"])
    child.name = "renamed"
    expect(child.name).toBe("renamed")
    child.opener = null
    expect(child.opener).toBeNull()
    expect(() => {
      child.opener = {} as never
    }).toThrow(TypeError)
  })

  it("has the global window's members on the global object", () => {
    openFirst()
    expect([window.opener, window.name, window.closed, window.frames, window.length]).toEqual([null, "", false, window, 0])
    expect(window.devicePixelRatio).toBeTypeOf("number")
    expect(window.open).toBeTypeOf("function")
    expect(window.close).toBeTypeOf("function")
    expect(window.focus).toBeTypeOf("function")
    expect(window.postMessage).toBeTypeOf("function")
    expect(globalWindow().document).toBe(documentOf(globalWindow().renderer as TestRenderer))
  })
})

describe.skipIf(!hasNativeTestRenderer)("the key window", () => {
  it("answers hasFocus from the platform's key window and focus() moves it", () => {
    const first = openFirst()
    const child = opened(window.open())
    const childRenderer = child.renderer as TestRenderer
    expect([globalDocument.hasFocus(), child.document.hasFocus()]).toEqual([false, true])
    first.activateWindow()
    expect([globalDocument.hasFocus(), child.document.hasFocus()]).toEqual([true, false])
    child.focus()
    expect([globalDocument.hasFocus(), child.document.hasFocus()]).toEqual([false, true])
    expect(childRenderer.isWindowKey()).toBe(true)
  })

  it("sends focus and blur to a window whose key status changes, while it listens for them", () => {
    const first = openFirst()
    const child = opened(window.open())
    const heard: string[] = []
    child.addEventListener("focus", (event) => heard.push(`focus:${event.target === child}`))
    child.addEventListener("blur", (event) => heard.push(`blur:${event.target === child}`))
    window.addEventListener("focus", () => heard.push("opener focus"))
    window.addEventListener("blur", () => heard.push("opener blur"))
    const childRenderer = child.renderer as TestRenderer
    childRenderer.setWindowActive(false)
    expect(heard).toEqual(["blur:true"])
    first.activateWindow()
    expect(heard).toEqual(["blur:true", "opener focus"])
    childRenderer.activateWindow()
    expect(heard).toEqual(["blur:true", "opener focus", "opener blur", "focus:true"])
    child.onfocus = () => heard.push("onfocus")
    childRenderer.setWindowActive(false)
    childRenderer.setWindowActive(true)
    expect(heard.slice(-3)).toEqual(["blur:true", "focus:true", "onfocus"])
  })
})
