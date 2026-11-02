import fs from "fs"
import type { ReactElement } from "react"
import { describe, expect, it } from "vitest"
import { defineKeyframes } from "../index"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"
import { readLogicalPixels, SHOTS_DIR } from "./test-utils.js"

const describeNative = hasNativeTestRenderer ? describe : describe.skip

// An offscreen effect group (an opacity that is not 1, held or animating) is drawn into a texture
// the size of what it paints. A blurred shadow is drawn beyond its rectangle by three times its
// blur radius, so a texture cut at the rectangle shows the shadow as a square. The shadow under a
// group at opacity A is the shadow of alpha a*A with no group, and the box is the fill of alpha A.

const EDGE = 120
const SIZE = 120
const PAGE = 2 * EDGE + SIZE
const SHADOW_ALPHA = 0.8
const TOLERANCE = 3

defineKeyframes("group-shadow-fade", { from: { opacity: 0.2 }, to: { opacity: 0.8 } })

type Pixels = ReturnType<typeof readLogicalPixels>

function capture(name: string, tree: ReactElement, advance?: number) {
  const testRoot = createTestRoot({ width: PAGE, height: PAGE })
  try {
    testRoot.renderer.clockPause()
    testRoot.render(tree)
    if (advance !== undefined) {
      testRoot.renderer.clockFastForward(advance)
    }
    const file = `${SHOTS_DIR}/group-shadow-blur-${name}.png`
    fs.rmSync(file, { force: true })
    testRoot.renderer.captureScreenshot(file)
    return readLogicalPixels(file, testRoot.renderer)
  } finally {
    testRoot.unmount()
  }
}

function boxShadow(blur: number, offsetY: number) {
  return (alpha: number) => `0 ${offsetY}px ${blur}px rgba(0, 0, 0, ${alpha})`
}

/** The black box and its shadow on a white page, faded as a group by `fade`, on the box or on a
 *  wrapper around it. */
function grouped(blur: number, offsetY: number, fade: Record<string, unknown>, onWrapper: boolean) {
  const box = (extra: Record<string, unknown>) => (
    <div
      style={{
        width: SIZE,
        height: SIZE,
        backgroundColor: "#000000",
        boxShadow: boxShadow(blur, offsetY)(SHADOW_ALPHA),
        ...extra,
      }}
    />
  )
  return (
    <div style={{ padding: EDGE, backgroundColor: "#ffffff" }}>
      {onWrapper ? <div style={fade}>{box({})}</div> : box(fade)}
    </div>
  )
}

/** The same at opacity `alpha`, painted with no group: the fill and the shadow carry the alpha. */
function flat(blur: number, offsetY: number, alpha: number) {
  return (
    <div style={{ padding: EDGE, backgroundColor: "#ffffff" }}>
      <div
        style={{
          width: SIZE,
          height: SIZE,
          backgroundColor: `rgba(0, 0, 0, ${alpha})`,
          boxShadow: boxShadow(blur, offsetY)(SHADOW_ALPHA * alpha),
        }}
      />
    </div>
  )
}

/** The opacity of a black box on white, read inside the box. */
function opacityOf(pixels: Pixels) {
  return 1 - pixels.at(EDGE + SIZE / 2, EDGE + SIZE / 2)[0] / 255
}

/** Points outside the box at each distance from every side, and from its corner. */
function ringPoints(distances: number[]) {
  const points: Array<[string, number, number]> = []
  const middle = EDGE + SIZE / 2
  for (const distance of distances) {
    points.push([`left ${distance}`, EDGE - distance - 1, middle])
    points.push([`right ${distance}`, EDGE + SIZE + distance, middle])
    points.push([`top ${distance}`, middle, EDGE - distance - 1])
    points.push([`bottom ${distance}`, middle, EDGE + SIZE + distance])
    points.push([`corner ${distance}`, EDGE - distance - 1, EDGE - distance - 1])
    points.push([`corner ${distance} below`, EDGE + SIZE + distance, EDGE + SIZE + distance])
  }
  return points
}

function expectSame(group: Pixels, reference: Pixels, distances: number[]) {
  for (const [where, x, y] of ringPoints(distances)) {
    const expected = reference.at(x, y)
    const actual = group.at(x, y)
    expect(
      Math.abs(actual[0] - expected[0]),
      `${where}: the group has ${actual[0]}, the same shadow with no group ${expected[0]}`
    ).toBeLessThanOrEqual(TOLERANCE)
  }
  let worst = 0
  let worstAt = ""
  for (let y = 0; y < PAGE; y++) {
    for (let x = 0; x < PAGE; x++) {
      const difference = Math.abs(group.at(x, y)[0] - reference.at(x, y)[0])
      if (difference > worst) {
        worst = difference
        worstAt = `(${x}, ${y})`
      }
    }
  }
  expect(worst, `the largest difference is at ${worstAt}`).toBeLessThanOrEqual(TOLERANCE)
}

/** The shadow is there to be compared: darker than the page by at least `margin` at each point. */
function expectShadowAt(reference: Pixels, distances: number[], margin: number) {
  for (const [where, x, y] of ringPoints(distances)) {
    expect(255 - reference.at(x, y)[0], `${where} is in the shadow`).toBeGreaterThanOrEqual(margin)
  }
}

describeNative("a shadow in an effect group", () => {
  // The shader draws a shadow of blur B over three sigma around its rectangle, and a CSS blur of B
  // is a sigma of B / 2, so up to 2 sigma (a shadow of 2.3%) is within what is compared.
  const CASES = [
    { name: "24px", blur: 24, offsetY: 0, distances: [2, 8, 16, 24, 30] },
    { name: "40px", blur: 40, offsetY: 0, distances: [2, 10, 20, 30, 40] },
    { name: "24px, moved down", blur: 24, offsetY: 10, distances: [2, 8, 16, 24] },
  ]

  for (const shadow of CASES) {
    describe(`of ${shadow.name}`, () => {
      for (const onWrapper of [false, true]) {
        const where = onWrapper ? "on an ancestor" : "on the box"

        it(`at a held opacity ${where} is the shadow of no group, at its alpha`, () => {
          const slug = `${shadow.name.replace(/\W+/g, "-")}-${onWrapper ? "wrapper" : "box"}`
          const group = capture(`held-${slug}`, grouped(shadow.blur, shadow.offsetY, { opacity: 0.5 }, onWrapper))
          const reference = capture(`held-${slug}-flat`, flat(shadow.blur, shadow.offsetY, 0.5))
          expectShadowAt(reference, shadow.distances.slice(0, 1), 4)
          expectSame(group, reference, shadow.distances)
        })

        it(`in the middle of an opacity animation ${where} is the shadow of no group, at its alpha`, () => {
          const slug = `${shadow.name.replace(/\W+/g, "-")}-${onWrapper ? "wrapper" : "box"}`
          const group = capture(
            `animated-${slug}`,
            grouped(shadow.blur, shadow.offsetY, { animation: "group-shadow-fade 1s linear forwards" }, onWrapper),
            500
          )
          const opacity = opacityOf(group)
          // From 0.2 to 0.8 over a second, half way.
          expect(opacity).toBeGreaterThan(0.45)
          expect(opacity).toBeLessThan(0.55)
          const reference = capture(`animated-${slug}-flat`, flat(shadow.blur, shadow.offsetY, opacity))
          expectShadowAt(reference, shadow.distances.slice(0, 1), 4)
          expectSame(group, reference, shadow.distances)
        })
      }
    })
  }
})
