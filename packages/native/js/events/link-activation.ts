import type { Element } from "../dom/nodes.js"
import { linkUrl } from "../dom/hyperlink.js"
import { normalizedInputType } from "../dom/input-type.js"
import { openLinkExternally } from "../shell/open-link.js"

/**
 * Whether `target` differs from the document's URL in its fragment only. Reads the global `location`, as `linkUrl` does:
 * with two copies of `@ghia/native` the module-level session may not be the one that installed `window.location`.
 */
function isFragmentNavigation(target: URL): boolean {
  const current = location.href
  const targetFragment = target.href.indexOf("#")
  if (targetFragment < 0) return false
  const currentFragment = current.indexOf("#")
  const currentBase = currentFragment < 0 ? current : current.slice(0, currentFragment)
  return target.href.slice(0, targetFragment) === currentBase
}

/** The first element on the path with an activation behaviour, as native picks it (`html::activation_target`). */
function activationTarget(path: readonly Element[]): Element | undefined {
  return path.find((element) => {
    if (element.localName === "label" || element.localName === "button") return true
    if (element.localName === "a" || element.localName === "area") return element.getAttribute("href") !== null
    if (element.localName !== "input") return false
    const type = normalizedInputType(element.getAttribute("type"))
    return type === "checkbox" || type === "radio"
  })
}

/** Whether a click that travels `path` would activate a link, so that the JS root has to see a click that nothing listens to. */
export function clickActivatesLink(path: readonly object[]): boolean {
  const target = activationTarget(path as readonly Element[])
  return target !== undefined && (target.localName === "a" || target.localName === "area")
}

/**
 * The activation behaviour of a click on a link that no listener canceled: following its `href`.
 * A URL that differs from the document's in its fragment only is a fragment navigation, as in a
 * browser, and fires `hashchange`; any other one would load a document and goes to `openLinkExternally`.
 * A link with `download` does nothing.
 */
export function followLinkOnClick(path: readonly object[]): void {
  const target = activationTarget(path as readonly Element[])
  if (target === undefined || (target.localName !== "a" && target.localName !== "area")) return
  if (target.getAttribute("download") !== null) return
  const url = linkUrl(target)
  if (url === null) return
  if (isFragmentNavigation(url)) location.assign(url.href)
  else openLinkExternally(url)
}
