import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { rewriteWorkerUrls, type WorkerBuildContext } from "../../dist/workers.js"

type Emitted = { file: string; fileName: string }

const ROOT = "/app"

function hash(path: string, environmentName = "ghia"): string {
  return createHash("sha256").update(`${environmentName}:${path}`).digest("hex").slice(0, 8)
}

async function rewrite(code: string, options: { id?: string; environmentName?: string; files?: Record<string, string | undefined> } = {}) {
  const emitted: Emitted[] = []
  const warnings: string[] = []
  const files = options.files ?? {}
  const context: WorkerBuildContext = {
    root: ROOT,
    environmentName: options.environmentName ?? "ghia",
    resolve: async (specifier) => (specifier in files ? files[specifier] : `/app/src/${specifier.replace(/^(\.\.?\/)+/, "")}`),
    emit: async (file, fileName) => {
      emitted.push({ file, fileName })
    },
    warn: (message) => warnings.push(message),
  }
  const result = await rewriteWorkerUrls(context, code, options.id ?? "/app/src/main.ts")
  return { result, emitted, warnings }
}

const RASTER = `raster-${hash("src/raster.ts")}.worker.js`

describe("rewriteWorkerUrls", () => {
  test.each(['"', "'", "`"])("rewrites a literal in %s quotes and emits the Worker file", async (quote) => {
    const { result, emitted } = await rewrite(`const w = new Worker(new URL(${quote}./raster.ts${quote}, import.meta.url))`)
    expect(result).toBe(`const w = new Worker(new URL("./${RASTER}", import.meta.url))`)
    expect(emitted).toEqual([{ file: "/app/src/raster.ts", fileName: RASTER }])
  })

  test("leaves the options argument as written", async () => {
    const { result } = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url), { type: "module", name: "r" })`)
    expect(result).toBe(`new Worker(new URL("./${RASTER}", import.meta.url), { type: "module", name: "r" })`)
  })

  test("accepts a trailing comma after import.meta.url", async () => {
    const { result } = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url,), { type: "module" })`)
    expect(result).toBe(`new Worker(new URL("./${RASTER}", import.meta.url,), { type: "module" })`)
  })

  test("accepts whitespace and line breaks inside the call", async () => {
    const { result } = await rewrite(`new Worker(\n  new URL(\n    "./raster.ts",\n    import.meta.url\n  )\n)`)
    expect(result).toBe(`new Worker(\n  new URL(\n    "./${RASTER}",\n    import.meta.url\n  )\n)`)
  })

  test("rewrites every Worker in a module", async () => {
    const { result, emitted } = await rewrite(
      `new Worker(new URL("./a.ts", import.meta.url));\nnew Worker(new URL("./b.ts", import.meta.url))`
    )
    expect(emitted.map((entry) => entry.fileName)).toEqual([`a-${hash("src/a.ts")}.worker.js`, `b-${hash("src/b.ts")}.worker.js`])
    expect(result).toBe(
      `new Worker(new URL("./${emitted[0].fileName}", import.meta.url));\nnew Worker(new URL("./${emitted[1].fileName}", import.meta.url))`
    )
  })

  test("names one file the same from every module, and two files with one stem differently", async () => {
    const files = { "./raster.ts": "/app/a/raster.ts", "./other/raster.ts": "/app/b/raster.ts" }
    const first = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`, { files })
    const again = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`, { files, id: "/app/a/other.ts" })
    const other = await rewrite(`new Worker(new URL("./other/raster.ts", import.meta.url))`, { files })
    expect(first.emitted[0].fileName).toBe(`raster-${hash("a/raster.ts")}.worker.js`)
    expect(again.emitted[0].fileName).toBe(first.emitted[0].fileName)
    expect(other.emitted[0].fileName).toBe(`raster-${hash("b/raster.ts")}.worker.js`)
    expect(other.emitted[0].fileName).not.toBe(first.emitted[0].fileName)
  })

  test("names one file differently in each environment", async () => {
    const ui = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`)
    const server = await rewrite(`new Worker(new URL("./raster.ts", import.meta.url))`, { environmentName: "server" })
    expect(server.emitted[0].fileName).toBe(`raster-${hash("src/raster.ts", "server")}.worker.js`)
    expect(server.emitted[0].fileName).not.toBe(ui.emitted[0].fileName)
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

  test.each([
    ["a line comment", `// new Worker(new URL("./gone.ts", import.meta.url))\nconst a = 1`],
    ["a block comment", `/**\n * const worker = new Worker(new URL('./gone.ts', import.meta.url))\n */\nconst a = 1`],
    ["a string", `const example = "new Worker(new URL('./gone.ts', import.meta.url))"`],
    ["a template literal", "const example = `new Worker(new URL('./gone.ts', import.meta.url))`"],
  ])("ignores a Worker in %s", async (_name, code) => {
    const { result, emitted } = await rewrite(code, { files: { "./gone.ts": undefined } })
    expect(result).toBeUndefined()
    expect(emitted).toEqual([])
  })

  test("rewrites a real Worker next to a commented one", async () => {
    const { result, emitted } = await rewrite(`// new Worker(new URL("./gone.ts", import.meta.url))\nnew Worker(new URL("./raster.ts", import.meta.url))`)
    expect(result).toBe(`// new Worker(new URL("./gone.ts", import.meta.url))\nnew Worker(new URL("./${RASTER}", import.meta.url))`)
    expect(emitted).toHaveLength(1)
  })

  test("warns and leaves the code as written when a Worker file in node_modules does not resolve", async () => {
    const code = `new Worker(new URL("./missing.js", import.meta.url))`
    const { result, emitted, warnings } = await rewrite(code, { id: "/app/node_modules/lib/index.js", files: { "./missing.js": undefined } })
    expect(result).toBeUndefined()
    expect(emitted).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Cannot resolve the Worker file "./missing.js"')
  })

  test("fails when the Worker file does not resolve", async () => {
    const run = rewrite(`new Worker(new URL("./missing.ts", import.meta.url))`, { files: { "./missing.ts": undefined } })
    await expect(run).rejects.toThrow('Cannot resolve the Worker file "./missing.ts" imported from /app/src/main.ts')
  })
})
