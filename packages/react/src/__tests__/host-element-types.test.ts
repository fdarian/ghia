import { afterAll, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

// A consumer program type-checked with `tsc`: host props and refs as an app written for React DOM types them, and as
// StyleX, Base UI and TanStack Virtual hand them over. Inside the package, so `@ghia/react` self-resolves to the built
// dist and `react` and `@types/react` resolve through its node_modules. A `@ts-expect-error` in a fixture is an
// assertion: an unused one fails the check.
const root = resolve(import.meta.dirname, "../..")
mkdirSync(join(root, "tmp"), { recursive: true })
const temp = mkdtempSync(join(root, "tmp/host-element-types-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const tscTimeout = 60_000
const tsc = join(root, "node_modules/typescript/bin/tsc")

const withDom = `import { useRef, type ForwardedRef, type Ref } from "react"
import type { ImgInstance, PublicInstance, TextControlInstance } from "@ghia/react"

// Typed as the libraries type them: TanStack Virtual's measureElement and StyleX's props().
declare const virtualizer: { measureElement: (node: Element | null) => void }
declare function styleProps(): { className?: string; style?: Readonly<{ [key: string]: string | number }> }

export function App(props: { divRef: Ref<HTMLDivElement>; inputRef: ForwardedRef<HTMLInputElement>; hostRef: Ref<PublicInstance> }) {
  const list = useRef<HTMLDivElement>(null)
  const ghia = useRef<PublicInstance>(null)
  const text = useRef<TextControlInstance>(null)
  const input = useRef<HTMLInputElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const anchor = useRef<HTMLAnchorElement>(null)
  const paragraph = useRef<HTMLParagraphElement>(null)
  const cell = useRef<HTMLTableCellElement>(null)
  const img = useRef<ImgInstance>(null)
  const svg = useRef<SVGSVGElement>(null)
  const path = useRef<SVGPathElement>(null)
  const sheet = useRef<HTMLStyleElement>(null)
  const wide = useRef<HTMLElement>(null)
  const span = useRef<HTMLSpanElement>(null)
  return (
    <div ref={list} {...styleProps()} className="app">
      <style ref={sheet}>{".app { color: red }"}</style>
      <div ref={virtualizer.measureElement} data-index={0} />
      <div ref={ghia} />
      <div ref={props.divRef} />
      <div ref={props.hostRef} />
      <div ref={null} />
      <div ref={(element) => { element?.nativeId; element?.align; element?.scrollTop }} />
      <div ref={(element: PublicInstance | null) => { element?.nativeId }} />
      <div ref={(element: HTMLDivElement | null) => { element?.align }} />
      <input ref={text} />
      <input ref={input} />
      <input ref={props.inputRef} />
      <input ref={(element) => {
        element?.select()
        element?.nativeId
        // @ts-expect-error the element is both types, not never
        const nothing: never = element!
      }} />
      <button ref={button} />
      <a ref={anchor} href="#" />
      <p ref={paragraph} />
      <table><tbody><tr><td ref={cell} /></tr></tbody></table>
      <img ref={img} />
      <img ref={(element) => element?.setImage(new Uint8Array())} />
      <svg ref={svg} className="icon"><path ref={path} className="line" d="M0 0" /></svg>
      <virtual-list className="rows" />
      <canvas ref={(element) => {
        // @ts-expect-error a canvas has no drawing context, so its element is an HTMLElement
        element?.getContext("2d")
      }} />
      {/* @ts-expect-error as in React DOM, a ref object of a wider DOM type does not fit */}
      <div ref={wide} />
      {/* @ts-expect-error another tag's DOM type */}
      <div ref={span} />
      {/* @ts-expect-error className is text */}
      <div className={1} />
    </div>
  )
}
`

// Without the DOM lib there is no HTMLDivElement to name: a ref is Ghia's own type, and the rest still holds.
const withoutDom = `import { useRef } from "react"
import type { PublicInstance } from "@ghia/react"

export function App() {
  const ghia = useRef<PublicInstance>(null)
  return (
    <div ref={ghia} className="app">
      <style>{".app { color: red }"}</style>
      <span ref={(element) => { element?.nativeId; element?.scrollTop }} />
    </div>
  )
}
`

function check(name: string, source: string, lib: string[], jsx: "react-jsx" | "react-jsxdev") {
  const directory = join(temp, name)
  mkdirSync(directory)
  writeFileSync(join(directory, "main.tsx"), source)
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx,
      jsxImportSource: "@ghia/react",
      strict: true,
      noEmit: true,
      // The dist's own declarations are not what this checks.
      skipLibCheck: true,
      lib,
      types: [],
    },
    files: ["main.tsx"],
  }))
  return spawnSync(process.execPath, [tsc, "-p", directory], { cwd: root, encoding: "utf8" })
}

describe("host element types", () => {
  it("take className, <style>, and refs typed as the DOM element or as Ghia's instance", () => {
    const result = check("dom", withDom, ["ES2022", "DOM"], "react-jsx")
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("are the same in the development runtime", () => {
    const result = check("dom-dev", withDom, ["ES2022", "DOM"], "react-jsxdev")
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("hold without the DOM lib", () => {
    const result = check("no-dom", withoutDom, ["ES2022"], "react-jsx")
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)
})
