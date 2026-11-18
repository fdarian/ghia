import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { existsSync } from "node:fs"
import { describe, expect, it } from "vitest"
import "../dom-globals.js"
import { isParse5Loaded } from "../dom/html/parse5.js"

const JS_ROOT = join(import.meta.dirname, "..")

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (name === "__tests__" || name === "node_modules") return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js)$/.test(name) && !name.endsWith(".d.ts") ? [path] : []
  })
}

describe("the HTML parser loads on first use", () => {
  it("is not loaded by the globals, and is by the first parse", () => {
    expect(isParse5Loaded()).toBe(false)
    const parser = new DOMParser()
    expect(isParse5Loaded()).toBe(false)
    expect(parser.parseFromString("<p>a<b>b</b></p>", "text/html").body.innerHTML).toBe("<p>a<b>b</b></p>")
    expect(isParse5Loaded()).toBe(true)
  })

  it("is read by value from parse5.js only: an app's startup would load it with any other import", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(JS_ROOT)) {
      const text = readFileSync(file, "utf8")
      const valueImport = /^\s*(import|export)\s+(?!type\b)[^;]*?from\s+["']parse5["']|^\s*import\s+["']parse5["']|\bimport\(\s*["']parse5["']/m
      if (valueImport.test(text)) offenders.push(relative(JS_ROOT, file))
      if (/\brequire\(\s*["']parse5["']\s*\)/.test(text) && !file.endsWith(join("dom", "html", "parse5.js"))) offenders.push(relative(JS_ROOT, file))
    }
    expect(offenders).toEqual([])
  })

  it("is left out of the web build, whose bundler is told to read parse5.web.js instead", () => {
    const manifest = JSON.parse(readFileSync(join(JS_ROOT, "..", "package.json"), "utf8"))
    const replacement = manifest.browser["./dist/dom/html/parse5.js"]
    expect(replacement).toBe("./dist/dom/html/parse5.web.js")
    expect(existsSync(join(JS_ROOT, "dom", "html", "parse5.web.js"))).toBe(true)
  })
})
