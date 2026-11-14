/**
 * A live list keeps what its last search found; the next change to the tree drops it, so a list nobody reads again
 * does not hold the elements it saw. The stand-in `<html>` is the tree here: it has a `<head>` and a `<body>`.
 */
import { describe, expect, it } from "vitest"
import { document } from "../events/window-target.js"
import { elementsRememberedBy } from "../dom/html-collection.js"
import { bumpTreeVersion } from "../dom/tree-version.js"
import "../dom-globals.js"

describe("what a live list holds between reads", () => {
  it("is the elements of its last search, and nothing after the next change to the tree", () => {
    const all = document.documentElement.getElementsByTagName("*")
    expect(elementsRememberedBy(all)).toEqual([])
    expect(all.length).toBe(2)
    expect(elementsRememberedBy(all)).toHaveLength(2)
    bumpTreeVersion()
    expect(elementsRememberedBy(all)).toEqual([])
    expect(all.length).toBe(2)
    expect(elementsRememberedBy(all)).toHaveLength(2)
  })

  it("is dropped by a write the list is not asked about", () => {
    const heads = document.documentElement.getElementsByTagName("head")
    const names = document.getElementsByName("none")
    expect(heads.length).toBe(1)
    expect(names.length).toBe(0)
    document.documentElement.setAttribute("lang", "en")
    expect(elementsRememberedBy(heads)).toEqual([])
    expect(heads[0]).toBe(document.head)
  })

  it("holds nothing for a search that found nothing, so it is never registered", () => {
    const none = document.documentElement.getElementsByTagName("article")
    expect(none.length).toBe(0)
    expect(elementsRememberedBy(none)).toEqual([])
  })
})
