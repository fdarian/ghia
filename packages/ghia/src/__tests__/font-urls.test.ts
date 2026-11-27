import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "vite"
import { ghia } from "../../dist/index.js"

const FONT = Buffer.from([0, 1, 0, 0, 1, 2, 3])

function fontPlugin(root: string, publicDir: string): { transform: (code: string, id: string) => unknown; build: (file: string) => boolean | undefined } {
  const [main, , fonts] = ghia({ entry: "main.ts" }) as [Plugin, Plugin, Plugin]
  const configResolved = fonts.configResolved
  if (typeof configResolved !== "function") throw new Error("configResolved is a function hook")
  configResolved.call({} as never, { root, publicDir } as never)
  const transform = fonts.transform
  if (typeof transform !== "object" || transform === null || typeof transform.handler !== "function") throw new Error("transform is an object hook")
  const configEnvironment = main.configEnvironment
  if (typeof configEnvironment !== "function") throw new Error("configEnvironment is a function hook")
  return {
    transform: (code, id) => {
      const filter = transform.filter?.id
      if (filter instanceof RegExp && !filter.test(id)) return undefined
      return transform.handler.call({} as never, code, id)
    },
    build: (file) => {
      const result = configEnvironment.call({} as never, "ghia", {}, { command: "build", mode: "production" }) as { build: { assetsInlineLimit: (file: string) => boolean | undefined } }
      return result.build.assetsInlineLimit(file)
    },
  }
}

function project(): { root: string; publicDir: string } {
  const root = mkdtempSync(join(tmpdir(), "ghia-font-urls-"))
  const publicDir = join(root, "public")
  mkdirSync(join(root, "src"))
  mkdirSync(publicDir)
  writeFileSync(join(root, "src", "a.ttf"), FONT)
  writeFileSync(join(publicDir, "b.otf"), FONT)
  return { root, publicDir }
}

const DATA = `data:font/ttf;base64,${FONT.toString("base64")}`

test("a font url() of CSS text in dev is read from the root and inlined", () => {
  const { root, publicDir } = project()
  const { transform } = fontPlugin(root, publicDir)
  const css = JSON.stringify('@font-face { font-family: A; src: url(/src/a.ttf) format("truetype"), url("/src/a.ttf"), url(/public-less/c.ttf), url(/src/missing.ttf) }')
  const result = transform(`export default ${css}`, "/x/app.css?inline") as { code: string }
  expect(result.code).toContain(`url(${DATA}) format(`)
  expect(result.code).toContain(`url(\\"${DATA}\\")`)
  expect(result.code).toContain("url(/public-less/c.ttf)")
  expect(result.code).toContain("url(/src/missing.ttf)")
})

test("a font of the public directory is inlined, an image and a module are left alone", () => {
  const { root, publicDir } = project()
  const { transform } = fontPlugin(root, publicDir)
  expect((transform('export default "a{src:url(/b.otf)}"', "/x/app.css?inline") as { code: string }).code).toContain("data:font/otf;base64,")
  expect(transform('export default "a{background:url(/src/a.png)}"', "/x/app.css?inline")).toBeUndefined()
  expect(transform('const font = "url(/src/a.ttf)"', "/x/app.ts")).toBeUndefined()
})

test("a build inlines a font of any size and leaves the size limit to Vite for the rest", () => {
  const { build } = fontPlugin("/", "/public")
  expect(build("/src/a.ttf")).toBe(true)
  expect(build("/src/B.OTF")).toBe(true)
  expect(build("/src/a.png")).toBeUndefined()
})
