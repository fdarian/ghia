import { afterAll, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

// A consumer program type-checked with `tsc`: host props and refs as an app written for solid-js on the web types
// them, and as TanStack Virtual hands them over. Inside the package, so `@ghia/solid` self-resolves to the built dist
// and `solid-js` resolves through its node_modules. A `@ts-expect-error` in a fixture is an assertion: an unused one
// fails the check.
const root = resolve(import.meta.dirname, "../..")
mkdirSync(join(root, "tmp"), { recursive: true })
const temp = mkdtempSync(join(root, "tmp/host-element-types-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const tscTimeout = 60_000
const tsc = join(root, "node_modules/typescript/bin/tsc")

const withDom = `import { motion, type HostElement, type JSX, type SolidHostProps } from "@ghia/solid"

// Typed as TanStack Virtual types it.
declare const virtualizer: { measureElement: (node: Element | null | undefined) => void }

export function App() {
  let list!: HTMLDivElement
  let input!: HTMLInputElement
  let host!: HostElement
  let wide!: HTMLElement
  let span!: HTMLSpanElement
  return (
    <div ref={list} class="app" classList={{ active: true, idle: false }}>
      <style>{".app { color: red }"}</style>
      <div ref={virtualizer.measureElement} data-index={0} />
      <motion.div ref={list} class="box" />
      <motion.div ref={(element: HTMLDivElement) => element.align} />
      <motion.path ref={(element) => { element.getTotalLength(); element.nativeId }} d="M0 0" />
      <div ref={host} />
      <div ref={(element) => { element.nativeId; element.align; element.scrollTop }} />
      <div ref={(element: HostElement) => element.nativeId} />
      <div ref={(element: HTMLDivElement) => element.align} />
      <input ref={input} />
      <input ref={(element) => { element.select(); element.value }} />
      <svg ref={(element) => { element.viewBox; element.nativeId }} class="icon">
        <path ref={(element: SVGPathElement) => element.getTotalLength()} class="line" d="M0 0" />
      </svg>
      <canvas ref={(element) => {
        // @ts-expect-error a canvas has no drawing context, so its element is an HTMLElement
        element.getContext("2d")
      }} />
      <label for="field" />
      <label htmlFor="field" />
      {/* @ts-expect-error as in solid-js, a variable of a wider DOM type does not fit */}
      <div ref={wide} />
      {/* @ts-expect-error another tag's DOM type */}
      <div ref={span} />
      {/* @ts-expect-error class is text */}
      <div class={1} />
    </div>
  )
}

// Props without a tag fit every element; a tag's props fit that element and its motion component.
export const Box = (props: SolidHostProps) => <><div {...props} /><button {...props} /><motion.div {...props} /></>
export const Div = (props: JSX.IntrinsicElements["div"]) => <><div {...props} /><motion.div {...props} /></>
`

// Without the DOM lib a ref is Ghia's own type alone, and the rest still holds.
const withoutDom = `import type { HostElement } from "@ghia/solid"

export function App() {
  let host!: HostElement
  return (
    <div ref={host} class="app">
      <style>{".app { color: red }"}</style>
      <span ref={(element) => { element.nativeId; element.scrollTop }} />
      {/* @ts-expect-error a ref is an element */}
      <div ref={5} />
    </div>
  )
}
`

function check(name: string, source: string, lib: string[]) {
  const directory = join(temp, name)
  mkdirSync(directory)
  writeFileSync(join(directory, "main.tsx"), source)
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "preserve",
      jsxImportSource: "@ghia/solid",
      strict: true,
      noEmit: true,
      // solid-js and @ghia/native's declarations name DOM types, so a program without the DOM lib needs it, and
      // the dist's own declarations are not what this checks.
      skipLibCheck: true,
      lib,
      types: [],
    },
    files: ["main.tsx"],
  }))
  return spawnSync(process.execPath, [tsc, "-p", directory], { cwd: root, encoding: "utf8" })
}

describe("host element types", () => {
  it("take class, classList, <style>, and refs typed as the DOM element or as a HostElement", () => {
    const result = check("dom", withDom, ["ES2022", "DOM"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("hold without the DOM lib, where a ref is a HostElement", () => {
    const result = check("no-dom", withoutDom, ["ES2022"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)
})
