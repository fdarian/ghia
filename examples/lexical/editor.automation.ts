/**
 * Drives the Lexical editor example (lexical/editor.tsx) through the automation client, in a window that never takes
 * the keyboard (`GPUIX_BACKGROUND=1`, `focus: false`), and screenshots every step into lexical/screens/ (gitignored,
 * 2x on a Retina display). It asserts on the editor state JSON and the selection the app prints beside the editor.
 *
 *   cd examples && bun lexical/editor.automation.ts
 *
 * The automation protocol has no composition, so the IME step is reported as SKIP: try it by hand (README.md).
 */

import path from "path"
import { fileURLToPath } from "url"
import { launch, type App } from "@ghia/react/automation"
import { FIRST_PARAGRAPH, LAST_PARAGRAPH, LONG_PARAGRAPH } from "./editor"

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, "..")
const shots = path.join(here, "screens")

const watchdog = setTimeout(() => {
  console.error("[automation] global watchdog fired, exiting")
  process.exit(2)
}, 240_000)
watchdog.unref?.()

interface TreeNode {
  id: number
  type: string
  text?: string
  testId?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: TreeNode[]
}

interface LexicalText {
  type: "text"
  text: string
  format: number
}
interface LexicalParagraph {
  type: "paragraph"
  children: LexicalText[]
}
interface LexicalState {
  root: { children: LexicalParagraph[] }
}
interface SelectionInfo {
  anchorKey: string
  anchorOffset: number
  focusKey: string
  focusOffset: number
  text: string
}

const BOLD = 1
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const app: App = await launch({
  command: "bun",
  // ghia dev has to run under Bun, and the .bin shim starts Node.
  args: [path.join(examples, "..", "packages", "ghia", "dist", "cli.js"), "dev", "lexical/editor.main.tsx"],
  cwd: examples,
  env: { GPUIX_BACKGROUND: "1" },
})

async function editorState(): Promise<LexicalState> {
  return until("the state JSON", async () => JSON.parse(await app.getByTestId("state").textContent()) as LexicalState, () => true)
}

function paragraphTexts(state: LexicalState): string[] {
  return state.root.children.map((paragraph) => paragraph.children.map((child) => child.text).join(""))
}

async function undoDepth(): Promise<number> {
  const line = await app.getByTestId("selection").textContent()
  const match = /undo depth: (\d+)$/.exec(line)
  if (match === null) throw new Error(`no undo depth: ${JSON.stringify(line)}`)
  return Number(match[1])
}

async function paragraphs(): Promise<string[]> {
  return paragraphTexts(await editorState())
}

async function selection(): Promise<SelectionInfo> {
  const line = await app.getByTestId("selection").textContent()
  const match = /^selection: (\S+):(\d+) -> (\S+):(\d+) (".*")\nundo depth: \d+$/.exec(line)
  if (match === null) throw new Error(`no range selection: ${JSON.stringify(line)}`)
  return {
    anchorKey: match[1],
    anchorOffset: Number(match[2]),
    focusKey: match[3],
    focusOffset: Number(match[4]),
    text: (JSON.parse(match[5]) as string).replace(/\\n/g, "\n"),
  }
}

async function until<T>(what: string, read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
  const started = Date.now()
  let last: T | undefined
  for (;;) {
    try {
      last = await read()
      if (accept(last)) return last
    } catch {
      // The editor may be between two renders.
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`)
    await sleep(30)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function equal(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, `${what}: expected ${e}, got ${a}`)
}

function walk(node: TreeNode, visit: (node: TreeNode, parent: TreeNode | undefined) => void, parent?: TreeNode): void {
  visit(node, parent)
  for (const child of node.children ?? []) walk(child, visit, node)
}

async function tree(): Promise<TreeNode> {
  const result = await app.call("getTree", {})
  if (result.tree === null) throw new Error("the automation tree is empty")
  return result.tree as TreeNode
}

/** The `<p>` blocks of the editor, in document order, with the text they hold. */
async function blocks(): Promise<Array<{ text: string; node: TreeNode }>> {
  const found: Array<{ text: string; node: TreeNode }> = []
  walk(await tree(), (node) => {
    if (node.type !== "p" || node.bounds === undefined) return
    let text = ""
    walk(node, (inner) => {
      if (inner.type === "#text") text += inner.text ?? ""
    })
    found.push({ text, node })
  })
  return found
}

async function block(text: string | ((text: string) => boolean)): Promise<TreeNode> {
  const accept = typeof text === "string" ? (value: string) => value.startsWith(text) : text
  const found = (await blocks()).filter((candidate) => accept(candidate.text))
  assert(found.length === 1, `expected one paragraph for ${String(text)}, got ${found.length}`)
  return found[0].node
}

function bounds(node: TreeNode): NonNullable<TreeNode["bounds"]> {
  if (node.bounds === undefined) throw new Error(`node ${node.id} has no bounds`)
  return node.bounds
}

/** The box of the text a paragraph holds (its spans), not of the block, which spans the panel's width. */
function textBox(paragraph: TreeNode): { x: number; y: number; width: number; height: number } {
  const spans = (paragraph.children ?? []).filter((child) => child.type === "span" && child.bounds !== undefined)
  if (spans.length === 0) return bounds(paragraph)
  const first = bounds(spans[0])
  const right = Math.max(...spans.map((span) => bounds(span).x + bounds(span).width))
  return { x: first.x, y: first.y, width: right - first.x, height: first.height }
}

/**
 * Clicks into a single-line paragraph until the caret sits at `offset`. The text is proportional, so the first guess
 * assumes equal advances and the click is walked by what the editor reports.
 */
async function placeCaret(startsWith: string, offset: number): Promise<{ x: number; y: number }> {
  const found = (await blocks()).filter((candidate) => candidate.text.startsWith(startsWith))
  assert(found.length === 1, `expected one paragraph for ${JSON.stringify(startsWith)}, got ${found.length}`)
  const box = textBox(found[0].node)
  const textLength = found[0].text.length
  const advance = box.width / textLength
  let x = box.x + advance * offset
  const tried: string[] = []
  const y = box.y + box.height / 2
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await app.mouse.click({ x, y })
    await sleep(120)
    const current = await selection()
    tried.push(`${x.toFixed(1)}->${current.anchorOffset}`)
    if (current.anchorOffset === offset && current.focusOffset === offset) return { x, y }
    x += (offset - current.anchorOffset) * advance * 0.8 + (offset > current.anchorOffset ? 1 : -1)
  }
  throw new Error(`could not place the caret at ${offset} in ${JSON.stringify(startsWith)} (${tried.join(", ")})`)
}

/**
 * One automation call per press, so `LEXICAL_TIMING` reports each key. (The client presses a sequence one key at a time
 * with the loop turning between them as well; Lexical commits in a microtask, so a sequence in one synchronous call,
 * as the test renderer's `simulateKeystrokes` makes it, would lose keys.)
 */
async function keys(presses: string): Promise<void> {
  for (const press of presses.split(" ")) {
    const started = Date.now()
    await app.call("keystrokes", { keys: press })
    if (process.env.LEXICAL_TIMING) console.log(`     ${press}: ${Date.now() - started} ms`)
    await sleep(40)
  }
  await sleep(60)
}

/** Printable ASCII as presses of the keyboard grammar. */
async function type(text: string): Promise<void> {
  const presses = [...text].map((ch) => (ch === " " ? "Space" : ch))
  await keys(presses.join(" "))
}

let failures = 0
let skipped = 0
let counter = 0

async function step(name: string, run: () => Promise<void>): Promise<void> {
  counter += 1
  const slug = `${String(counter).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
  let outcome = "PASS"
  let detail = ""
  try {
    await run()
  } catch (error) {
    failures += 1
    outcome = "FAIL"
    detail = ` ${error instanceof Error ? error.message : String(error)}`
  }
  await sleep(150)
  const file = path.join(shots, `${slug}.png`)
  await app.screenshot({ path: file })
  console.log(`${outcome} ${slug}${detail}  [undo depth ${await undoDepth().catch(() => "?")}]`)
}

const history: string[][] = []
const remember = async (): Promise<string[]> => {
  const texts = await paragraphs()
  history.push(texts)
  return texts
}

try {
  await app.getByTestId("bold").waitFor({ timeoutMs: 60_000 })
  await until("seeded state", () => app.getByTestId("state").textContent(), (text) => text !== "")

  await step("initial", async () => {
    equal(await paragraphs(), [FIRST_PARAGRAPH, "", LONG_PARAGRAPH, LAST_PARAGRAPH], "seeded paragraphs")
    await remember()
  })

  await step("click-mid-word-and-type", async () => {
    // "The quick brown": offset 12 is between "br" and "own".
    await placeCaret(FIRST_PARAGRAPH, 12)
    await type("mid")
    const texts = await until("the typed word", paragraphs, (value) => value[0].includes("mid"))
    equal(texts[0], "The quick brmidown fox jumps over the lazy dog.", "first paragraph")
    const caret = await selection()
    assert(caret.anchorOffset === 15 && caret.focusOffset === 15, `caret after typing at 15, got ${caret.anchorOffset}`)
    await remember()
  })

  await step("enter-and-type", async () => {
    await keys("Enter")
    await type("new")
    const texts = await until("the split paragraph", paragraphs, (value) => value.length === 5 && value[1].startsWith("new"))
    equal(texts[0], "The quick brmid", "first half")
    equal(texts[1], "newown fox jumps over the lazy dog.", "second half")
    equal(texts[2], "", "the empty paragraph stays")
    await remember()
  })

  await step("select-word-and-bold", async () => {
    // The automation protocol sends every press with a click count of 1, so a double click cannot be driven: two
    // clicks only move the caret twice. The word is selected the keyboard's way instead (Option+Shift+Right from
    // its start), and the double click is left to the README.
    console.log("SKIP double-click: the automation protocol has no click count")
    skipped += 1
    await placeCaret("The quick brmid", 4)
    await keys("Alt+Shift+ArrowRight")
    const word = await until("the word selected", selection, (value) => value.text.length > 0)
    equal(word.text, "quick", "the selected word")
    await keys("Meta+b")
    const state = await until("bold applied", editorState, (value) =>
      value.root.children[0].children.some((child) => child.format & BOLD)
    )
    const bold = state.root.children[0].children.filter((child) => child.format & BOLD).map((child) => child.text)
    equal(bold, ["quick"], "bold runs")
    equal(paragraphTexts(state)[0], "The quick brmid", "text unchanged")
    await remember()
  })

  let dragged: SelectionInfo
  await step("drag-select-across-paragraphs", async () => {
    const first = textBox(await block("The quick brmid"))
    const second = textBox(await block("newown"))
    // From inside "brmid" to inside "newown fox".
    await app.mouse.drag(
      { x: first.x + first.width - 14, y: first.y + first.height / 2 },
      { x: second.x + second.width * 0.3, y: second.y + second.height / 2 },
      { steps: 12 }
    )
    dragged = await until("a range over two paragraphs", selection, (value) => value.text.includes("\n"))
    assert(dragged.anchorKey !== dragged.focusKey, "the range spans two text nodes")
    const head = dragged.text.split("\n")[0]
    assert("The quick brmid".endsWith(head) && head.length > 0, `range starts inside "brmid": ${JSON.stringify(dragged.text)}`)
    assert(dragged.text.split("\n")[1].startsWith("new"), `range reaches into "newown": ${JSON.stringify(dragged.text)}`)
  })

  await step("shift-arrow-extends", async () => {
    await keys("Shift+ArrowRight Shift+ArrowRight Shift+ArrowRight")
    const after = await until("the range extended", selection, (value) => value.text.length === dragged.text.length + 3)
    equal([after.anchorKey, after.anchorOffset], [dragged.anchorKey, dragged.anchorOffset], "the anchor stays")
    dragged = after
  })

  await step("option-backspace-deletes-selection", async () => {
    const before = await paragraphs()
    await keys("Alt+Backspace")
    const texts = await until("the range deleted", paragraphs, (value) => value.length === before.length - 1)
    // The selected text is the end of the first paragraph, a line break and the start of the second.
    const [head, tail] = dragged.text.split("\n")
    equal(texts[0], before[0].slice(0, before[0].length - head.length) + before[1].slice(tail.length), "the two paragraphs merged around the range")
    await remember()
  })

  await step("option-backspace-deletes-word", async () => {
    await type(" one two")
    const typed = await until("typed words", paragraphs, (value) => value[0].includes(" one two"))
    await keys("Alt+Backspace")
    const texts = await until("the word deleted", paragraphs, (value) => !value[0].includes("two"))
    equal(texts[0], typed[0].replace(" one two", " one "), "Option+Backspace takes the word before the caret and keeps the space before it")
    await remember()
  })

  await step("click-empty-paragraph-and-type", async () => {
    const empty = bounds(await block((text) => text === ""))
    await app.mouse.click({ x: empty.x + 30, y: empty.y + empty.height / 2 })
    await sleep(120)
    const caret = await selection()
    equal([caret.anchorOffset, caret.focusOffset, caret.text], [0, 0, ""], "caret in the empty paragraph")
    await type("hello")
    const texts = await until("typing in the empty paragraph", paragraphs, (value) => value.includes("hello"))
    assert(texts.filter((text) => text === "hello").length === 1, "one paragraph holds exactly hello")
    await remember()
  })

  // The automation protocol has no input method; the by-hand check is in README.md.
  console.log("SKIP composition: no IME helper in the automation client")
  skipped += 1

  let undos = 0
  await step("undo", async () => {
    const before = await paragraphs()
    // Lexical's history groups typing, so a burst takes more than one Cmd+Z.
    for (; undos < 40; ) {
      await sleep(400)
      await keys("Meta+z")
      undos += 1
      const texts = await until("undo to change the text", paragraphs, (value) => JSON.stringify(value) !== JSON.stringify(before))
      if (history.some((older) => JSON.stringify(older) === JSON.stringify(texts))) return
      before.splice(0, before.length, ...texts)
    }
    throw new Error("undo never reached an earlier state")
  })

  await step("redo", async () => {
    for (let redo = 0; redo < undos; redo += 1) {
      await sleep(100)
      await keys("Meta+Shift+z")
    }
    const texts = await until("redo", paragraphs, (value) => value.includes("hello"))
    assert(texts.includes("hello"), "hello is back")
  })

  await step("select-across-wrapped-lines", async () => {
    const long = textBox(await block("Lexical is"))
    const lineHeight = 22.5
    await app.mouse.click({ x: long.x + long.width * 0.4, y: long.y + lineHeight * 1.5 })
    await sleep(150)
    const start = await selection()
    equal(start.text, "", "a click leaves a caret")
    await keys("Shift+ArrowDown Shift+ArrowDown")
    const range = await until("a range over the wrapped lines", selection, (value) => value.text.length > 60)
    assert(range.anchorKey === range.focusKey, "the range stays in the long paragraph")
    assert(range.anchorOffset === start.anchorOffset, "the anchor stays where the click put it")
    assert(range.focusOffset > range.anchorOffset + 60, `the range spans two lines: ${range.text.length} characters`)
  })

  await step("typing-at-the-bottom-scrolls-the-caret-into-view", async () => {
    const panel = await app.getByTestId("panel").element()
    const before = await app.call("getScrollOffset", { elementId: panel.id })
    await placeCaret(LAST_PARAGRAPH, LAST_PARAGRAPH.length)
    await keys("Enter Enter Enter")
    await type("bottom")
    await until("the new paragraphs", paragraphs, (value) => value.includes("bottom"))
    const after = await until(
      "the panel scrolled",
      () => app.call("getScrollOffset", { elementId: panel.id }),
      (value) => value.offset !== null && value.offset[1] > 0
    )
    assert(before.offset === null || before.offset[1] === 0, `the panel started at the top: ${JSON.stringify(before.offset)}`)
    assert(after.offset !== null && after.offset[1] > 0, "the panel scrolled to keep the caret in view")
  })

  console.log(`[automation] done, ${failures} failure(s), ${skipped} skipped`)
} finally {
  await app.close()
}

process.exit(failures === 0 ? 0 : 1)
