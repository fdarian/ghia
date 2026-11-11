import { describe, expect, test } from "bun:test"
import { WorkerFiles, type WorkerBuildContext } from "../../dist/workers.js"

type Emitted = { file: string; fileName: string }

function contextFor(emitted: Emitted[], files: Record<string, string | undefined> = {}): WorkerBuildContext {
  return {
    resolve: async (specifier) => (specifier in files ? files[specifier] : `/app/src/${specifier.replace(/^(\.\.?\/)+/, "")}`),
    emit: (file, fileName) => {
      emitted.push({ file, fileName })
    },
  }
}

async function rewrite(code: string, options: { id?: string; files?: Record<string, string | undefined>; workers?: WorkerFiles } = {}) {
  const emitted: Emitted[] = []
  const workers = options.workers ?? new WorkerFiles()
  const result = await workers.rewrite("ghia", contextFor(emitted, options.files), code, options.id ?? "/app/src/main.ts")
  return { result, emitted, workers }
}

describe("WorkerFiles.rewrite", () => {
  test.each(['"', "'", "`"])("rewrites a literal in %s quotes and emits the Worker file", async (quote) => {
    const { result, emitted } = await rewrite(`const w = new Worker(new URL(${quote}./raster.ts${quote}, import.meta.url))`)
    expect(result).toBe('const w = new Worker(new URL("./raster.worker.js", import.meta.url))')
    expect(emitted).toEqual([{ file: "/app/src/raster.ts", fileName: "raster.worker.js" }])
  })

  test("leaves the options argument as written", async () => {
    const { result } = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url), { type: "module", name: "r" })`)
    expect(result).toBe(`new Worker(new URL("./raster.worker.js", import.meta.url), { type: "module", name: "r" })`)
  })

  test("accepts whitespace and line breaks inside the call", async () => {
    const { result } = await rewrite(`new Worker(\n  new URL(\n    "../raster.ts",\n    import.meta.url\n  )\n)`)
    expect(result).toBe(`new Worker(\n  new URL(\n    "./raster.worker.js",\n    import.meta.url\n  )\n)`)
  })

  test("rewrites every Worker in a module", async () => {
    const { result, emitted } = await rewrite(
      `new Worker(new URL("./a.ts", import.meta.url));\nnew Worker(new URL("./b.ts", import.meta.url))`
    )
    expect(result).toBe(`new Worker(new URL("./a.worker.js", import.meta.url));\nnew Worker(new URL("./b.worker.js", import.meta.url))`)
    expect(emitted.map((entry) => entry.fileName)).toEqual(["a.worker.js", "b.worker.js"])
  })

  test("gives one file one name across modules, and a second file with the same stem another", async () => {
    const workers = new WorkerFiles()
    const files = { "./raster.ts": "/app/a/raster.ts", "./other/raster.ts": "/app/b/raster.ts" }
    const first = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`, { workers, files })
    const again = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`, { workers, files, id: "/app/a/other.ts" })
    const collision = await rewrite(`new Worker(new URL("./other/raster.ts", import.meta.url))`, { workers, files })
    expect(first.emitted[0].fileName).toBe("raster.worker.js")
    expect(again.emitted[0].fileName).toBe("raster.worker.js")
    expect(collision.emitted[0].fileName).toBe("raster-2.worker.js")
    expect(workers.forEnvironment("ghia")).toEqual(["raster.worker.js", "raster-2.worker.js"])
    expect(workers.forEnvironment("server")).toEqual([])
  })

  test.each(["virtual:ghia/server", "\0virtual:ghia/server"])("skips the virtual module %s", async (id) => {
    const { result, emitted } = await rewrite(`new Worker(new URL("./server.js", import.meta.url))`, { id })
    expect(result).toBeUndefined()
    expect(emitted).toEqual([])
  })

  test.each([
    ["a bare specifier", `new Worker(new URL("worker-lib/worker.js", import.meta.url))`],
    ["an absolute URL", `new Worker(new URL("https://example.com/w.js", import.meta.url))`],
    ["a template with an expression", "new Worker(new URL(`./${name}.ts`, import.meta.url))"],
    ["a variable", `new Worker(new URL(spec, import.meta.url))`],
    ["another base", `new Worker(new URL("./w.ts", base))`],
    ["a string path", `new Worker("./w.ts")`],
    ["a URL that is not passed to Worker", `const u = new URL("./w.ts", import.meta.url)`],
  ])("leaves %s alone", async (_name, code) => {
    const { result, emitted } = await rewrite(code)
    expect(result).toBeUndefined()
    expect(emitted).toEqual([])
  })

  test("fails when the Worker file does not resolve", async () => {
    const run = rewrite(`new Worker(new URL("./missing.ts", import.meta.url))`, { files: { "./missing.ts": undefined } })
    await expect(run).rejects.toThrow('Cannot resolve the Worker file "./missing.ts" imported from /app/src/main.ts')
  })
})
