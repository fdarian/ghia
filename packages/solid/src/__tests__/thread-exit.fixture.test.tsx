// Run by thread-exit.test.tsx in a child process; skipped in a normal run.
import { describe, it } from "vitest"
import {
  Dialog,
  DialogBackdrop,
  DialogPopup,
  DialogPortal,
  DialogTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "../index.js"
import { createTestRoot, hasNativeTestRenderer } from "../testing.js"

const scenario = process.env.GPUIX_THREAD_EXIT_FIXTURE

describe.skipIf(!hasNativeTestRenderer || !scenario)("thread exit fixture", () => {
  it("throws with a floating layer still mounted", () => {
    const app = createTestRoot()
    if (scenario === "tooltip") {
      app.render(() => (
        <Tooltip defaultOpen>
          <TooltipTrigger style={{ width: 100, height: 32 }}><div>hover</div></TooltipTrigger>
          <TooltipContent><div>help</div></TooltipContent>
        </Tooltip>
      ))
    } else {
      app.render(() => (
        <Dialog defaultOpen>
          <DialogTrigger style={{ width: 80, height: 24 }}><div>Open</div></DialogTrigger>
          <DialogPortal>
            <DialogBackdrop style={{ backgroundColor: "#00000080" }} />
            <DialogPopup style={{ width: 300, backgroundColor: "#1e293b" }}><div>Settings</div></DialogPopup>
          </DialogPortal>
        </Dialog>
      ))
    }
    throw new Error("fixture failure")
  })
})
