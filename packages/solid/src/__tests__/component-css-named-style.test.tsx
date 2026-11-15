/** Ghia's own components read a `style` the way the host does: a CSS property name is the camelCase key it names. */
import { describe, expect, it } from "vitest"
import { Dialog, DialogPortal, Tooltip, TooltipContent, TooltipTrigger } from "../index.js"
import type { HostElement } from "../host.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

describe.skipIf(!hasNativeTestRenderer)("Ghia's Solid components and a style written with CSS property names", () => {
  it("keeps a DialogPortal's \"pointer-events\" while the dialog is modal, and none while it is not", () => {
    const app = createTestRoot()
    const style = { "pointer-events": "auto" } as Record<string, unknown>
    let modal: HostElement | undefined
    let nonModal: HostElement | undefined
    app.render(() => (
      <>
        <Dialog open modal>
          <DialogPortal ref={(element: HostElement) => (modal = element)} style={style} />
        </Dialog>
        <Dialog open modal={false}>
          <DialogPortal ref={(element: HostElement) => (nonModal = element)} style={style} />
        </Dialog>
      </>
    ))
    expect(modal!.liveStyle.pointerEvents).toBe("auto")
    expect(nonModal!.liveStyle.pointerEvents).toBe("none")
    app.unmount()
  })

  it("lifts a TooltipContent's \"pointer-events\" onto the layer it is anchored in", () => {
    const app = createTestRoot()
    let content: HostElement | undefined
    app.render(() => (
      <Tooltip open>
        <TooltipTrigger style={{ width: 40, height: 20 }} />
        <TooltipContent ref={(element: HostElement) => (content = element)} style={{ "pointer-events": "none" } as Record<string, unknown>} />
      </Tooltip>
    ))
    const layer = content!.parentNode as HostElement
    expect(layer.liveStyle).toEqual({ pointerEvents: "none" })
    app.unmount()
  })
})
