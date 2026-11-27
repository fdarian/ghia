import { windowOf } from "./events/window-target.js"
import type { GpuixWindow } from "./events/window-targets.js"
import type { NativeRenderer } from "./host.js"
import { namedError } from "./named-error.js"
import { location } from "./shell/location.js"
import { opensInSystem, openLinkExternally } from "./shell/open-link.js"
import { session } from "./shell/session.js"
import { registerRoot } from "./roots.js"
import {
  closeWindowObject,
  findNamedWindow,
  focusWindowObject,
  registerWindowDisposer,
  trackOpenedWindow,
  windowGone,
} from "./window-lifecycle.js"

/**
 * What an adapter does to give a window `window.open` made a root: it mounts an empty one on
 * the new renderer (an element source with `<html>`, `<head>` and `<body>`, and the node factory),
 * as `render()` does for the first window, and an app renders into `window.document.body`. What
 * it returns is called once when the window closes, to unmount that root: before the platform closes
 * the window when a script's `window.close()` does it, and after it when the user did (the native
 * window is gone then, `isWindowClosed()` says so, and a batch sent to it is applied to the tree only).
 */
export type WindowFactory = (renderer: NativeRenderer) => void | (() => void)

const factories = new WeakMap<object, WindowFactory>()

/**
 * An adapter's root registers how its window makes the windows that `window.open` opens from it. A
 * window a factory opened has the same factory, so its own `window.open` works too. The returned
 * function takes it back, as the root unmounts.
 */
export function registerWindowFactory(renderer: NativeRenderer, factory: WindowFactory): () => void {
  factories.set(renderer, factory)
  return () => {
    if (factories.get(renderer) === factory) factories.delete(renderer)
  }
}

/** The options a window made by `window.open` opens with: the part of `WindowOptions` a script can ask for. */
export type OpenedWindowOptions = {
  title?: string
  width?: number
  height?: number
  x?: number
  y?: number
}

/** How a kind of renderer (the live one, the test one) opens a sibling of itself. */
export type WindowOpener = {
  /** Makes a renderer with its window open on the same app, in the same frame loop. */
  create(options: OpenedWindowOptions): NativeRenderer
  /** The title of the opener's window, which a window opened from it starts with. */
  title(): string | undefined
}

const openers = new WeakMap<object, WindowOpener>()

/** @internal A renderer says how it makes a sibling window: `createNativeRenderer` and the test renderer do. */
export function bindWindowOpener(renderer: object, opener: WindowOpener): void {
  openers.set(renderer, opener)
}

const FEATURE_SEPARATORS = new Set(["\t", "\n", "\f", "\r", " ", "=", ","])

/** HTML's "tokenize the features string": names and values lowercased, and the aliases of the sizes and the position normalized. */
export function tokenizeFeatures(features: string): Map<string, string> {
  const tokens = new Map<string, string>()
  const end = features.length
  let position = 0
  const collect = (accept: (char: string) => boolean): string => {
    const start = position
    while (position < end && accept(features[position])) position += 1
    return features.slice(start, position)
  }
  while (position < end) {
    collect((char) => FEATURE_SEPARATORS.has(char))
    let name = collect((char) => !FEATURE_SEPARATORS.has(char)).toLowerCase()
    let value = ""
    while (position < end && features[position] !== "=") {
      if (FEATURE_SEPARATORS.has(features[position]) && features[position] !== ",") position += 1
      else break
    }
    if (position < end && FEATURE_SEPARATORS.has(features[position])) {
      while (position < end && FEATURE_SEPARATORS.has(features[position])) {
        if (features[position] === ",") break
        position += 1
      }
      value = collect((char) => !FEATURE_SEPARATORS.has(char)).toLowerCase()
    }
    name = NORMALIZED_NAMES[name] ?? name
    if (name !== "") tokens.set(name, value)
  }
  return tokens
}

const NORMALIZED_NAMES: Record<string, string> = {
  screenx: "left",
  screeny: "top",
  innerwidth: "width",
  innerheight: "height",
}

/** HTML's "check if a window feature is set": a bare name or a true value, as `noopener` and `popup` are written. */
function featureIsSet(tokens: Map<string, string>, name: string): boolean {
  const value = tokens.get(name)
  if (value === undefined) return false
  if (value === "" || value === "yes" || value === "true") return true
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? false : parsed !== 0
}

/** The integer a feature value starts with, or `undefined` for none. */
function featureNumber(tokens: Map<string, string>, name: string): number | undefined {
  const value = tokens.get(name)
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The size and place a features string asks for. */
export function featureOptions(tokens: Map<string, string>): OpenedWindowOptions {
  const options: OpenedWindowOptions = {}
  const width = featureNumber(tokens, "width")
  const height = featureNumber(tokens, "height")
  if (width !== undefined && width > 0) options.width = width
  if (height !== undefined && height > 0) options.height = height
  const left = featureNumber(tokens, "left")
  const top = featureNumber(tokens, "top")
  // The platform places a window only when it has both coordinates.
  if (left !== undefined && top !== undefined) {
    options.x = left
    options.y = top
  }
  return options
}

function resolve(url: string): URL {
  try {
    return new URL(url, session.url)
  } catch {
    throw namedError("SyntaxError", `Failed to execute 'open' on 'Window': Unable to open a window with invalid URL '${url}'.`)
  }
}

function notSupported(url: string): Error {
  return namedError(
    "NotSupportedError",
    `window.open('${url}'): Ghia has no document loading, so a window cannot show a URL. Call window.open('') and render into the new window's document.body.`
  )
}

function missing(what: string, opener: GpuixWindow): Error {
  return new Error(`window.open needs ${what} for the renderer of ${opener.renderer === undefined ? "a window with a mounted root" : "this window"}`)
}

/**
 * `window.open(url, target, features)` of `opener`'s window. `""` and `about:blank` open a new
 * native window with an empty document, which the opener's adapter gives a root. A link to another
 * origin goes to the system's handler, and returns `null`. A target of `_self`, `_parent` and
 * `_top` navigates the opener as `location.assign` does. A named target that is open is found and
 * focused, and `_blank` always opens. Any other URL throws `NotSupportedError`.
 */
export function openWindow(opener: GpuixWindow, urlArgument: string | URL, target: string, featuresArgument: string): object | null {
  const url = String(urlArgument)
  const parsed = url === "" ? undefined : resolve(url)
  const blank = parsed === undefined || parsed.href === "about:blank"
  const targetName = target === "" ? "_blank" : target
  const lowered = targetName.toLowerCase()

  if (lowered === "_self" || lowered === "_parent" || lowered === "_top") {
    // The document cannot be replaced by a blank one either, so `open("", "_self")` leaves the window as it is.
    if (!blank) location.assign(url)
    return opener.view
  }

  if (!blank) {
    if (opensInSystem(parsed)) {
      openLinkExternally(parsed)
      return null
    }
    // As a link with this scheme: the engine runs nothing.
    if (parsed.protocol === "javascript:") return null
    throw notSupported(url)
  }

  const tokens = tokenizeFeatures(featuresArgument)
  const detached = featureIsSet(tokens, "noopener") || featureIsSet(tokens, "noreferrer")
  const openerRenderer = opener.renderer
  if (openerRenderer === undefined) throw missing("a window", opener)

  if (lowered !== "_blank") {
    const existing = findNamedWindow(targetName)
    if (existing !== undefined) {
      if (existing.mountedRenderer === undefined) mountRoot(opener, openerRenderer, existing)
      focusWindowObject(existing)
      return detached ? null : existing.view
    }
  }

  const windowOpener = openers.get(openerRenderer)
  if (windowOpener === undefined) throw missing("a renderer that can open a sibling window", opener)
  // Checked before the window opens, so that a missing factory leaves no window behind.
  factoryOf(opener, openerRenderer)

  const options = featureOptions(tokens)
  const title = windowOpener.title()
  if (title !== undefined) options.title = title
  const created = windowOpener.create(options)
  const opened = windowOf(created)
  try {
    mountRoot(opener, openerRenderer, opened)
  } catch (error) {
    created.closeWindow?.()
    windowGone(created)
    throw error
  }
  opened.name = lowered === "_blank" ? "" : targetName
  opened.openerLink = detached ? null : opener
  trackOpenedWindow(opened)
  return detached ? null : opened.view
}

function factoryOf(opener: GpuixWindow, openerRenderer: NativeRenderer): WindowFactory {
  const factory = factories.get(openerRenderer)
  if (factory === undefined) {
    throw missing("a root that can make an empty root for the new window (render() of @ghia/solid or @ghia/react registers one)", opener)
  }
  return factory
}

/**
 * Gives `target`'s window a root made by the factory of the opener's: a window `window.open` just made, or a named one whose
 * root is gone (the app unmounted it, a test renderer was disposed) and that a script finds again. Closing the window, and
 * `unmountAllRoots` (`ghia dev` running the entry again), end the root and the window with it, so a reload does not leave the
 * old popups open for the new run to open again.
 */
function mountRoot(opener: GpuixWindow, openerRenderer: NativeRenderer, target: GpuixWindow): void {
  const factory = factoryOf(opener, openerRenderer)
  const renderer = target.renderer
  if (renderer === undefined) throw missing("a window that has a renderer", target)
  const dispose = factory(renderer)
  factories.set(renderer, factory)
  const unregisterReload = registerRoot(() => closeWindowObject(target))
  registerWindowDisposer(renderer, () => {
    unregisterReload()
    dispose?.()
  })
}
