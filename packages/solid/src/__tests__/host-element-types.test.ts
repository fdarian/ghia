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

// A style object typed by solid-js, whose lengths are csstype's `string | 0`, goes to the `style` of every host
// element without a cast.
const withCssProperties = `import { motion } from "@ghia/solid"
import type { JSX } from "solid-js"

export const visuallyHidden: JSX.CSSProperties = {
  clip: "rect(0 0 0 0)",
  overflow: "hidden",
  "white-space": "nowrap",
  position: "fixed",
  top: 0,
  left: 0,
  border: 0,
  padding: 0,
  width: "1px",
  height: "1px",
  margin: "-1px",
  mask: 0,
}

declare const written: JSX.CSSProperties

export const App = () => (
  <>
    <span style={visuallyHidden} />
    <div style={written} />
    <motion.div style={written} />
    <svg style={written} />
  </>
)
`

// An object literal with the CSS names of the properties, as a web Solid app writes one: the kebab-case name of each
// `StyleDesc` key takes that key's value type or any CSS text or number, and a motion value where the camelCase key takes one.
const withCssNamedKeys = `import { motion, motionValue } from "@ghia/solid"

const padding = motionValue(0)

export const App = () => (
  <>
    <div style={{ "white-space": "nowrap", "z-index": 1, "padding-top": 4, "--gap": "4px", "-webkit-font-smoothing": "antialiased", whiteSpace: "pre" }} />
    <motion.div style={{ "padding-left": padding, "background-color": "red" }} />
    <motion.span style={{ "font-weight": 700 }} />
    <svg style={{ "pointer-events": "none" }} />
    {/* @ts-expect-error a motion value only where the camelCase key takes one */}
    <div style={{ "white-space": padding }} />
    {/* @ts-expect-error z-index is a number */}
    <div style={{ "z-index": {} }} />
    {/* @ts-expect-error a name that is no property of a style */}
    <div style={{ "not-a-property": 1 }} />
  </>
)
`

// The props a web Solid component takes as solid-js types them (`JSX.HTMLAttributes<HTMLSpanElement>`, the base of
// every element's props) spread onto the matching host element without a cast. The event handlers, `style` and `tabIndex`
// are left out: a host handler takes Ghia's own event type, a host `style` is an object, and a host `tabIndex` is a
// number where solid-js's is a number or text.
const withSolidAttributes = `import type { JSX } from "solid-js"

declare const spanProps: Omit<JSX.HTMLAttributes<HTMLSpanElement>, "style" | "tabIndex" | \`on\${string}\`>
declare const buttonProps: Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "style" | "tabIndex" | \`on\${string}\`>

export const App = () => (
  <>
    <span {...spanProps} />
    <button {...buttonProps} />
    <span draggable="true" popover={false} aria-level="2" />
    <span draggable="false" popover />
    <span draggable />
    {/* @ts-expect-error draggable is true or false */}
    <span draggable="maybe" />
  </>
)
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

  it("take a style typed as solid-js's CSSProperties", () => {
    const result = check("css-properties", withCssProperties, ["ES2022", "DOM"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("take a style object literal written with CSS property names", () => {
    const result = check("css-named-keys", withCssNamedKeys, ["ES2022", "DOM"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("take the props solid-js types for an element spread onto it", () => {
    const result = check("solid-attributes", withSolidAttributes, ["ES2022", "DOM"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)

  it("hold without the DOM lib, where a ref is a HostElement", () => {
    const result = check("no-dom", withoutDom, ["ES2022"])
    expect(result.status, result.stdout).toBe(0)
  }, tscTimeout)
})
