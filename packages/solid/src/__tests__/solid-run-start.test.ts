import { describe, expect, test, vi } from "vitest"
import type { Plugin, ResolvedConfig } from "vite"
import { RUN_START_MODULE, solid } from "../vite.ts"

// Under vitest every dependency is inlined, and Vite's own server code cannot be evaluated that way.
vi.mock("vite-plugin-solid", () => ({ default: () => ({ name: "vite-plugin-solid" }) }))
vi.mock("ghia", () => ({
  ENVIRONMENT_NAME: "ghia",
  SERVER_ENVIRONMENT_NAME: "server",
  findPluginApi: (plugins: Array<{ name: string; api: unknown }>) => plugins.find((plugin) => plugin.name === "ghia")!.api,
}))

const ENTRY = "/app/main.tsx"

function configure(command: "serve" | "build", mode: string): { runStart: Plugin; resolved: ResolvedConfig } {
  const plugins = solid()
  const resolved = {
    command,
    mode,
    plugins: [{ name: "ghia", api: { entry: ENTRY } }],
  } as unknown as ResolvedConfig
  const refresh = plugins.find((plugin) => plugin.name === "ghia:solid-refresh")!
  ;(refresh.configResolved as (config: ResolvedConfig) => void)(resolved)
  return { runStart: plugins.find((plugin) => plugin.name === "ghia:solid-run-start")!, resolved }
}

function transform(plugin: Plugin, environment: string, code: string, id: string) {
  const hook = plugin.transform as { handler: Function }
  return hook.handler.call({ environment: { name: environment } }, code, id)
}

describe("the run-start module of solid()", () => {
  test("is the first import of the entry in ghia dev, on the line the entry starts on", () => {
    const { runStart } = configure("serve", "development")

    const result = transform(runStart, "ghia", 'import { createSignal } from "solid-js"\nrender()', ENTRY)

    expect(result.code).toBe(`import "${RUN_START_MODULE}"; import { createSignal } from "solid-js"\nrender()`)
  })

  test("is not added to any other module, which would reset the flag in the middle of a run", () => {
    const { runStart } = configure("serve", "development")

    expect(transform(runStart, "ghia", "export {}", "/app/other.tsx")).toBeUndefined()
    expect(transform(runStart, "ghia", "export {}", "/app/node_modules/solid-js/dist/dev.js")).toBeUndefined()
  })

  test("is not added to the entry in another environment, in a build or under vitest", () => {
    expect(transform(configure("serve", "development").runStart, "server", "export {}", ENTRY)).toBeUndefined()
    expect(transform(configure("build", "production").runStart, "ghia", "export {}", ENTRY)).toBeUndefined()
    expect(transform(configure("serve", "test").runStart, "ghia", "export {}", ENTRY)).toBeUndefined()
  })

  test("is a module that deletes the flag solid-js sets, and only resolves in ghia dev", () => {
    const { runStart } = configure("serve", "development")
    const resolveId = (runStart.resolveId as { handler: Function }).handler
    const resolved = resolveId.call({}, RUN_START_MODULE)

    expect(resolved).toBe(`\0${RUN_START_MODULE}`)
    expect((runStart.load as Function).call({}, resolved)).toBe("delete globalThis.Solid$$\n")
    expect(((configure("build", "production").runStart.resolveId as { handler: Function }).handler).call({}, RUN_START_MODULE)).toBeUndefined()
  })
})
