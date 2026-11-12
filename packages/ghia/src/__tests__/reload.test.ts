import { describe, expect, test } from "bun:test"
import type { ModuleRunner } from "vite/module-runner"
import { createFullReload, createSerialQueue, type FullReloadPayload } from "../reload.ts"
import { createUiHotChannel } from "../ui-channel.ts"

const payload: FullReloadPayload = { type: "full-reload", triggeredBy: "/app/main.ts" }

function fakeRunner(steps: string[], loadedFiles: string[] = [payload.triggeredBy as string]): ModuleRunner {
  return {
    evaluatedModules: {
      getModulesByFile: (file: string) => (loadedFiles.includes(file) ? new Set([{}]) : undefined),
    },
    hmrClient: {
      notifyListeners: async (event: string) => {
        steps.push(`notify ${event}`)
      },
    },
    clearCache: () => steps.push("clearCache"),
  } as unknown as ModuleRunner
}

describe("createFullReload", () => {
  test("announces the reload, stops the old run, clears the runner's caches, then starts again", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps),
      stop: () => steps.push("stop"),
      start: async () => {
        steps.push("start")
      },
    })
    reload(payload)
    await new Promise<void>((resolve) => enqueue(async () => resolve()))

    expect(steps).toEqual(["notify vite:beforeFullReload", "stop", "clearCache", "start"])
  })

  test("logs a failing stop and still clears the caches and starts again", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps),
      stop: () => {
        throw new Error("the teardown fails")
      },
      start: async () => {
        steps.push("start")
      },
    })
    const error = console.error
    const logged: unknown[] = []
    console.error = (value: unknown) => logged.push(value)
    try {
      reload(payload)
      await new Promise<void>((resolve) => enqueue(async () => resolve()))
    } finally {
      console.error = error
    }

    expect(logged).toEqual([new Error("the teardown fails")])
    expect(steps).toEqual(["notify vite:beforeFullReload", "clearCache", "start"])
  })

  test("skips a payload whose triggeredBy file is not in the runner's module graph", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps, ["/app/other.ts"]),
      stop: () => steps.push("stop"),
      start: async () => {
        steps.push("start")
      },
    })
    reload(payload)
    await new Promise<void>((resolve) => enqueue(async () => resolve()))

    expect(steps).toEqual([])
  })

  test("reloads a payload whose triggeredBy file is in the runner's module graph", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps, ["/app/main.ts"]),
      start: async () => {
        steps.push("start")
      },
    })
    reload(payload)
    await new Promise<void>((resolve) => enqueue(async () => resolve()))

    expect(steps).toEqual(["notify vite:beforeFullReload", "clearCache", "start"])
  })

  test("reloads a payload without triggeredBy whatever the module graph holds", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps, []),
      start: async () => {
        steps.push("start")
      },
    })
    reload({ type: "full-reload" })
    await new Promise<void>((resolve) => enqueue(async () => resolve()))

    expect(steps).toEqual(["notify vite:beforeFullReload", "clearCache", "start"])
  })

  test("runs reloads one at a time, and a failing start does not block the next one", async () => {
    const steps: string[] = []
    const enqueue = createSerialQueue()
    let starts = 0
    const reload = createFullReload({
      enqueue,
      runner: () => fakeRunner(steps),
      start: async () => {
        const run = ++starts
        steps.push(`start ${run}`)
        await Bun.sleep(20)
        steps.push(`started ${run}`)
        if (run === 1) throw new Error("the first start fails")
      },
    })
    const error = console.error
    console.error = () => {}
    try {
      reload(payload)
      reload(payload)
      await new Promise<void>((resolve) => enqueue(async () => resolve()))
    } finally {
      console.error = error
    }

    expect(steps.filter((step) => step.startsWith("start"))).toEqual(["start 1", "started 1", "start 2", "started 2"])
  })
})

describe("createUiHotChannel", () => {
  test("hands full-reload payloads to onFullReload and everything else to the runner", () => {
    const channel = createUiHotChannel()
    const delivered: string[] = []
    channel.api.outsideEmitter.on("send", (sent: { type: string }) => delivered.push(sent.type))
    const reloads: FullReloadPayload[] = []
    channel.onFullReload = (received) => reloads.push(received)

    channel.send?.(payload)
    channel.send?.({ type: "connected" })

    expect(reloads).toEqual([payload])
    expect(delivered).toEqual(["connected"])
  })

  test("leaves full-reload to the runner while nobody has taken it over", () => {
    const channel = createUiHotChannel()
    const delivered: string[] = []
    channel.api.outsideEmitter.on("send", (sent: { type: string }) => delivered.push(sent.type))

    channel.send?.(payload)

    expect(delivered).toEqual(["full-reload"])
  })
})
