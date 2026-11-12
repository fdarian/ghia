import { describe, expect, it } from "vitest"
import { normalizeKeyframes, prepareKeyframes } from "../animate-keyframes.js"

const parse = (input: Parameters<typeof normalizeKeyframes>[0]) => JSON.parse(normalizeKeyframes(input)) as Record<string, unknown>[]

describe("normalizeKeyframes", () => {
  it("makes keyframes of a property-indexed object, a property with n values at i / (n - 1)", () => {
    expect(parse({ translate: ["0px 0px", "100px 0px"] })).toEqual([
      { offset: 0, easing: "linear", translate: "0px 0px" },
      { offset: 1, easing: "linear", translate: "100px 0px" },
    ])
    expect(parse({ opacity: [0, 0.5, 1], width: ["1px", "2px"] })).toEqual([
      { offset: 0, easing: "linear", opacity: "0", width: "1px" },
      { offset: 0.5, easing: "linear", opacity: "0.5" },
      { offset: 1, easing: "linear", opacity: "1", width: "2px" },
    ])
  })

  it("puts the only value of a property at the end", () => {
    expect(parse({ opacity: 0.5 })).toEqual([{ offset: 1, easing: "linear", opacity: "0.5" }])
  })

  it("takes offset and easing of a property-indexed object as a value or a list", () => {
    expect(parse({ opacity: [0, 1, 0], offset: [0, 0.2, 1], easing: ["ease-in", "ease-out"] })).toEqual([
      { offset: 0, easing: "ease-in", opacity: "0" },
      { offset: 0.2, easing: "ease-out", opacity: "1" },
      { offset: 1, easing: "ease-in", opacity: "0" },
    ])
  })

  it("spreads the offsets an array of keyframes leaves out", () => {
    const frames = parse([{ opacity: 0 }, { opacity: 0.2 }, { offset: 0.8, opacity: 0.8 }, { opacity: 0.9 }, { opacity: 1 }])
    expect(frames.map((frame) => Math.round((frame.offset as number) * 100) / 100)).toEqual([0, 0.4, 0.8, 0.9, 1])
    expect(parse([{ opacity: 1 }])[0].offset).toBe(1)
    expect(parse([{ offset: 0.25, opacity: 1 }, { opacity: 0 }]).map((frame) => frame.offset)).toEqual([0.25, 1])
  })

  it("keeps the easing of a keyframe, and leaves out composite and undefined values", () => {
    expect(parse([{ opacity: 0, easing: "ease-in", composite: "replace" }, { opacity: undefined, width: 3 }])).toEqual([
      { offset: 0, easing: "ease-in", opacity: "0" },
      { offset: 1, easing: "linear", width: "3" },
    ])
  })

  it("takes nothing as no keyframes", () => {
    expect(normalizeKeyframes(null)).toBe("[]")
    expect(normalizeKeyframes(undefined)).toBe("[]")
    expect(parse([])).toEqual([])
  })

  it("throws a TypeError for an offset out of range or order, and for what is no keyframe", () => {
    expect(() => normalizeKeyframes([{ offset: 1.5 }])).toThrow(TypeError)
    expect(() => normalizeKeyframes([{ offset: 0.5 }, { offset: 0.2 }])).toThrow(TypeError)
    expect(() => normalizeKeyframes([{ offset: Number.NaN }])).toThrow(TypeError)
    expect(() => normalizeKeyframes([3 as never])).toThrow(TypeError)
    expect(() => normalizeKeyframes("opacity" as never)).toThrow(TypeError)
  })

  it("tells the offsets the author gave from the ones it spread", () => {
    expect(prepareKeyframes([{ opacity: 0 }, { opacity: 0.2 }, { offset: 0.8, opacity: 0.8 }, { opacity: 1 }]).written).toEqual([0.8])
    expect(prepareKeyframes({ opacity: [0, 1, 0], offset: [0, 0.2] }).written).toEqual([0, 0.2])
    expect(prepareKeyframes({ opacity: [0, 1] }).written).toEqual([])
  })
})
