import { createSignal } from "solid-js"
import { describe, expect, it } from "vitest"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Solid draggable elements", () => {
  it("drags an element onto a target and drops its data there", () => {
    const log: string[] = []
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 400, height: 400, display: "flex", flexDirection: "column" }}>
        <div
          draggable
          style={{ width: 100, height: 100 }}
          onDragStart={(event) => {
            event.dataTransfer!.setData("text/plain", "solid")
            log.push(event.type)
          }}
          onDragEnd={(event) => log.push(`${event.type}:${event.dataTransfer!.dropEffect}`)}
        />
        <div
          style={{ width: 100, height: 100 }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => log.push(`${event.type}:${event.dataTransfer!.getData("text/plain")}`)}
        />
      </div>
    ))

    app.renderer.nativeSimulateMouseDown(50, 50)
    app.renderer.nativeSimulateMouseMove(60, 150)
    app.renderer.nativeSimulateMouseUp(60, 150)

    expect(log).toEqual(["dragstart", "drop:solid", "dragend:copy"])
  })

  it("follows the draggable prop and cancels a drag from dragstart", () => {
    const log: string[] = []
    const [draggable, setDraggable] = createSignal(false)
    const app = createTestRoot()
    app.render(() => (
      <div
        draggable={draggable()}
        style={{ width: 100, height: 100 }}
        onDragStart={(event) => {
          log.push(event.type)
          event.preventDefault()
        }}
        onPointerMove={(event) => log.push(event.type)}
      />
    ))

    app.renderer.nativeSimulateMouseDown(50, 50)
    app.renderer.nativeSimulateMouseMove(80, 50)
    app.renderer.nativeSimulateMouseUp(80, 50)
    expect(log).toEqual(["pointermove"])

    log.length = 0
    app.flushSync(() => setDraggable(true))
    app.renderer.nativeSimulateMouseDown(50, 50)
    app.renderer.nativeSimulateMouseMove(80, 50)
    app.renderer.nativeSimulateMouseMove(81, 50)
    app.renderer.nativeSimulateMouseUp(81, 50)
    expect(log).toEqual(["dragstart", "pointermove"])
  })

  it("reads draggable as the DOM's enumerated text: \"true\" is a drag source and \"false\" is not", () => {
    const started: string[] = []
    const app = createTestRoot()
    app.render(() => (
      <div style={{ width: 400, height: 200, display: "flex" }}>
        <div draggable="false" style={{ width: 100, height: 100 }} onDragStart={() => started.push("false")} />
        <div draggable="true" style={{ width: 100, height: 100 }} onDragStart={() => started.push("true")} />
      </div>
    ))

    for (const x of [50, 150]) {
      app.renderer.nativeSimulateMouseDown(x, 50)
      app.renderer.nativeSimulateMouseMove(x + 30, 50)
      app.renderer.nativeSimulateMouseMove(x + 31, 50)
      app.renderer.nativeSimulateMouseUp(x + 31, 50)
    }
    expect(started).toEqual(["true"])
  })
})
