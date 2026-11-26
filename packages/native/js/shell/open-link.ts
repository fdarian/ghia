const warned = new Set<string>()

/**
 * Where a link that is not a fragment navigation goes. Ghia has one document and cannot load another,
 * so for now the link is reported once and nothing happens; this is the only place that changes when
 * other origins open in the system browser.
 */
export function openLinkExternally(url: URL): void {
  if (warned.has(url.href)) return
  warned.add(url.href)
  console.warn(`Ghia has no document navigation: the link to '${url.href}' was not followed.`)
}
