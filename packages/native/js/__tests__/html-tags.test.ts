import fs from "fs"
import { describe, expect, it } from "vitest"
import { HTML_INLINE_TAGS, HTML_TAGS, isHtmlTag, isInlineHtmlTag } from "../html-tags.js"
import { motionValue } from "../host.js"
import { syncMotionBindings, type MotionBindingHost } from "../motion-bindings.js"
import { BUILT_IN_TYPES, forwardsCustomProp } from "../mutations.js"

describe("HTML tags", () => {
  it("are the tags of the user agent style table of the native side", () => {
    const source = fs.readFileSync(new URL("../../src/html/tags.rs", import.meta.url), "utf8")
    const native = [...source.matchAll(/^\s*\(\s*"([a-z0-9]+)",/gm)].map((match) => match[1])
    expect([...HTML_TAGS].sort()).toEqual(native.sort())
  })

  it("leave out the elements Ghia builds itself", () => {
    for (const type of ["div", "span", "label", "form", "img", "svg", "input", "textarea", "code", "select", "nativeview"]) {
      expect(isHtmlTag(type), type).toBe(false)
    }
  })

  it("forward the props of every host element, and `href`, `type` and `disabled` where a tag has them", () => {
    for (const tag of HTML_TAGS) expect(BUILT_IN_TYPES.has(tag), tag).toBe(true)
    expect(forwardsCustomProp("p", "testId")).toBe(true)
    expect(forwardsCustomProp("p", "aria-label")).toBe(true)
    expect(forwardsCustomProp("p", "href")).toBe(false)
    expect(forwardsCustomProp("a", "href")).toBe(true)
    expect(forwardsCustomProp("a", "disabled")).toBe(false)
    expect(forwardsCustomProp("button", "disabled")).toBe(true)
    expect(forwardsCustomProp("button", "type")).toBe(true)
    expect(forwardsCustomProp("button", "href")).toBe(false)
  })

  it("list as inline the tags whose native style is display inline", () => {
    const source = fs.readFileSync(new URL("../../src/html/tags.rs", import.meta.url), "utf8")
    const inline = [...source.matchAll(/^\s*\(\s*"([a-z0-9]+)",\s*r#*"\{"display":"inline"/gm)].map((match) => match[1])
    expect([...HTML_INLINE_TAGS].sort()).toEqual(inline.sort())
    expect(isInlineHtmlTag("a")).toBe(true)
    expect(isInlineHtmlTag("span")).toBe(false)
    expect(isInlineHtmlTag("button")).toBe(false)
  })

  describe("motion values", () => {
    const host = {} as MotionBindingHost
    const mutations = { setCustomProp() {} }

    it("bind only what an inline box shows, for a span and for every inline tag", () => {
      for (const type of ["span", ...HTML_INLINE_TAGS]) {
        expect(() => syncMotionBindings(host, mutations, 1, { width: motionValue(1) }, type), type).toThrow(
          `A ${type} cannot take a motion value in style.width`
        )
      }
    })
  })
})
