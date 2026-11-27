import type { NativeRenderer } from "../host.js"

export type LinkHost = Pick<NativeRenderer, "openUrl">

const warned = new Set<string>()

let activeHost: LinkHost | undefined

/** Point `openLinkExternally` at the renderer created last. */
export function bindLinkOpener(host: LinkHost): void {
  activeHost = host
}

/** The schemes the system opens a link in, as a browser hands them to the OS. `javascript:` runs nothing, and the rest is not followed. */
const SYSTEM_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"])

/**
 * Where a link that is not a fragment navigation goes. Ghia has one document and cannot load another:
 * a link to another origin (`http:`, `https:`, `mailto:` and `tel:`) is opened by the system's default
 * handler, `javascript:` does nothing, and any other link, including a same-origin one that a router
 * is to take, is reported once and not followed.
 */
export function openLinkExternally(url: URL): void {
  if (url.protocol === "javascript:") return
  if (SYSTEM_SCHEMES.has(url.protocol) && url.origin !== location.origin) {
    if (activeHost === undefined) throw new Error("No Ghia renderer is running to open the link in the system's handler")
    activeHost.openUrl(url.href)
    return
  }
  if (warned.has(url.href)) return
  warned.add(url.href)
  console.warn(`Ghia has no document navigation: the link to '${url.href}' was not followed.`)
}
