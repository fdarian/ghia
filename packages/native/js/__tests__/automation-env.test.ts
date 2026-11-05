import { describe, expect, it } from "vitest"
import { launch } from "../automation/client.js"
import { AUTOMATION_ENV, automationRequested } from "../automation/env.js"

describe("automation is requested by environment", () => {
  it("is on only for GPUIX_AUTOMATION=1", () => {
    expect(automationRequested({ [AUTOMATION_ENV]: "1" })).toBe(true)
    expect(automationRequested({})).toBe(false)
    expect(automationRequested({ [AUTOMATION_ENV]: "0" })).toBe(false)
    expect(automationRequested({ [AUTOMATION_ENV]: "true" })).toBe(false)
  })

  it("launch() sets it in the child, over whatever env the caller passes", async () => {
    // The child answers initialize only when it sees the variable, so a launch that does not
    // set it never completes.
    const script = [
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", (chunk) => {',
      '  const request = JSON.parse(chunk.replace(/^data: /, "").trim())',
      `  if (process.env.${AUTOMATION_ENV} !== "1") process.exit(3)`,
      '  process.stdout.write("data: " + JSON.stringify({ id: request.id, result: { protocolVersion: 1, pid: process.pid, capabilities: [], window: { width: 1, height: 1 } } }) + "\\n\\n")',
      "})",
    ].join("\n")
    const app = await launch({
      command: "bun",
      args: ["-e", script],
      env: { [AUTOMATION_ENV]: "0" },
    })
    await app.close()
  })
})
