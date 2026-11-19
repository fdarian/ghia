/// The Solid half of the React test of the same name: an `outside` marker is the item's for the pointer, and `list-style`
/// in a state style changes the marker.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { document } from "@ghia/native/host"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const shots = fs.mkdtempSync(path.join(os.tmpdir(), "gpuix-solid-list-marker-pointer-"))
afterAll(() => fs.rmSync(shots, { recursive: true, force: true }))

const PAGE = { width: 300, height: 120, "background-color": "#ffffff", color: "#000000", "font-size": 16, "line-height": "24px", "font-family": "Helvetica" }
const BULLET = { x: 26, y: 12 }

describe.skipIf(!hasNativeTestRenderer)("the pointer over an outside marker, in Solid", () => {
  it("elementFromPoint and a click land on the item over its bullet", () => {
    let item!: HostElement
    const log: string[] = []
    const app = createTestRoot({ width: 300, height: 120 })
    try {
      app.render(() => (
        <div style={PAGE}>
          <ul style={{ margin: 0, "padding-left": 40 }} onClick={() => log.push("ul")}>
            <li ref={item} onClick={() => log.push("li")}>
              text
            </li>
          </ul>
        </div>
      ))
      expect(document.elementFromPoint(BULLET.x, BULLET.y)).toBe(item)
      expect(document.elementFromPoint(12, BULLET.y)).not.toBe(item)
      app.renderer.nativeSimulateClick(BULLET.x, BULLET.y)
      expect(log).toEqual(["li", "ul"])
    } finally {
      app.unmount()
    }
  })

  it("`hover: { listStyleType }` of the item changes its marker", () => {
    const draw = (item: Record<string, unknown>, move?: [number, number]) => {
      const app = createTestRoot({ width: 300, height: 120 })
      try {
        app.render(() => (
          <div style={PAGE}>
            <ul style={{ margin: 0, "padding-left": 40, color: "#ff0000" }}>
              <li style={item}>
                <span style={{ color: "#000000" }}>text</span>
              </li>
            </ul>
          </div>
        ))
        app.renderer.nativeSimulateMouseMove(...(move ?? [250, 100]))
        app.renderer.dispatchNativeEvents()
        const file = path.join(shots, `${Math.random().toString(36).slice(2)}.png`)
        app.renderer.captureScreenshot(file)
        return fs.readFileSync(file)
      } finally {
        app.unmount()
      }
    }
    const square = draw({ listStyleType: "square" })
    const plain = draw({ hover: { listStyleType: "square" } })
    const hovered = draw({ hover: { listStyleType: "square" } }, [150, 12])
    expect(plain.equals(square)).toBe(false)
    expect(hovered.equals(square)).toBe(true)
  })
})
