/**
 * Drives the two Lexical apps (main.react.tsx, main.solid.tsx) through the automation client, in a window that never
 * takes the keyboard (`GPUIX_BACKGROUND=1`, `focus: false`): types a sentence, selects a word, checks the floating
 * toolbar sits above it, bolds it from the toolbar, undoes, makes a list and a link. Screenshots go to
 * lexical/screens/ (gitignored).
 *
 *   cd examples && bun lexical/apps.automation.ts react
 *   cd examples && bun lexical/apps.automation.ts solid
 *
 * The automation protocol has no `eval`, so the checks read what the window paints: the tree (tags, text, bounds).
 */

import path from "path"
import { fileURLToPath } from "url"
import { launch, type App } from "@ghia/react/automation"

const flavor = process.argv[2]
if (flavor !== "react" && flavor !== "solid") throw new Error("usage: bun lexical/apps.automation.ts react|solid")

const here = path.dirname(fileURLToPath(import.meta.url))
const examples = path.resolve(here, "..")
const shots = path.join(here, "screens")

const watchdog = setTimeout(() => {
  console.error("[automation] global watchdog fired, exiting")
  process.exit(2)
}, 240_000)
watchdog.unref?.()

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}
interface TreeNode {
  id: number
  type: string
  text?: string
  testId?: string
  bounds?: Bounds
  children?: TreeNode[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const app: App = await launch({
  command: "bun",
  // ghia dev has to run under Bun, and the .bin shim starts Node.
  args: [path.join(examples, "..", "packages", "ghia", "dist", "cli.js"), "dev", `lexical/main.${flavor}.tsx`],
  cwd: examples,
  env: { GPUIX_BACKGROUND: "1" },
})

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function until<T>(what: string, read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 4_000): Promise<T> {
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
    await sleep(40)
  }
}

function walk(node: TreeNode, visit: (node: TreeNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

async function tree(): Promise<TreeNode> {
  const result = await app.call("getTree", {})
  if (result.tree === null) throw new Error("the automation tree is empty")
  return result.tree as TreeNode
}

function textOf(node: TreeNode): string {
  let text = ""
  walk(node, (inner) => {
    if (inner.type === "#text") text += inner.text ?? ""
  })
  return text
}

/** Every element of `type` in the editor, in document order, with the text it holds. */
async function elements(type: string): Promise<Array<{ text: string; node: TreeNode }>> {
  const editor = await app.getByTestId("editor").element()
  const root = await tree()
  const found: Array<{ text: string; node: TreeNode }> = []
  walk(root, (node) => {
    if (node.id === editor.id) {
      walk(node, (inner) => {
        if (inner.type === type && inner.bounds !== undefined) found.push({ text: textOf(inner), node: inner })
      })
    }
  })
  return found
}

async function paragraphs(): Promise<string[]> {
  return (await elements("p")).map((entry) => entry.text)
}

async function toolbarBounds(): Promise<Bounds> {
  const node = await app.getByTestId("floating-toolbar").element()
  if (node.bounds === undefined) throw new Error("the floating toolbar has no bounds")
  return node.bounds
}

async function pressButton(testId: string): Promise<void> {
  await app.getByTestId(testId).click()
  await sleep(200)
}

async function keys(presses: string): Promise<void> {
  for (const press of presses.split(" ")) {
    await app.call("keystrokes", { keys: press })
    await sleep(40)
  }
  await sleep(80)
}

async function type(text: string): Promise<void> {
  await keys([...text].map((ch) => (ch === " " ? "Space" : ch)).join(" "))
}

let failures = 0
let counter = 0

async function step(name: string, run: () => Promise<void>): Promise<void> {
  counter += 1
  let outcome = "PASS"
  let detail = ""
  try {
    await run()
  } catch (error) {
    failures += 1
    outcome = "FAIL"
    detail = ` ${error instanceof Error ? error.message : String(error)}`
  }
  console.log(`${outcome} ${flavor} ${String(counter).padStart(2, "0")} ${name}${detail}`)
}

async function shot(name: string): Promise<string> {
  await sleep(200)
  const file = path.join(shots, `${flavor}-${name}.png`)
  await app.screenshot({ path: file })
  console.log(`     screenshot ${file}`)
  return file
}

const SENTENCE = "Ghia draws this sentence natively"

try {
  await app.getByTestId("editor").waitFor({ timeoutMs: 90_000 })
  await until("the seeded document", paragraphs, (value) => value.some((text) => text.startsWith("Start typing")))

  await step("seeded document", async () => {
    const texts = await paragraphs()
    assert(texts.some((text) => text.startsWith("Lexical runs here with")), `seed paragraph missing: ${JSON.stringify(texts)}`)
    assert((await elements("h1")).length === 1 && (await elements("h2")).length === 1, "one h1 and one h2")
    assert((await elements("li")).length === 6, "six list items")
    assert((await elements("a")).length === 1, "one link")
    assert((await elements("strong")).length >= 1, "bold text is a <strong>")
    await shot("1-seeded")
  })

  await step("type a sentence in the last paragraph", async () => {
    const all = await elements("p")
    const last = all[all.length - 1].node
    assert(last.bounds !== undefined, "the last paragraph has bounds")
    await app.mouse.click({ x: last.bounds!.x + 30, y: last.bounds!.y + last.bounds!.height / 2 })
    await sleep(150)
    await type(SENTENCE)
    await until("the typed sentence", paragraphs, (value) => value.includes(SENTENCE))
  })

  let wordBox: Bounds
  await step("a word selected shows the floating toolbar above it", async () => {
    await keys("Alt+Shift+ArrowLeft")
    const toolbar = await until("the floating toolbar", toolbarBounds, () => true)
    const sentence = (await elements("p")).find((entry) => entry.text === SENTENCE)
    assert(sentence !== undefined, "the sentence paragraph")
    wordBox = sentence!.node.bounds!
    assert(toolbar.y + toolbar.height <= wordBox.y, `the toolbar (${JSON.stringify(toolbar)}) is above the line (${JSON.stringify(wordBox)})`)
    assert(toolbar.y >= 0 && toolbar.x >= 0, "the toolbar is inside the window")
    await shot("2-floating-toolbar")
  })

  await step("Bold in the floating toolbar makes a <strong>, aligned with the toolbar", async () => {
    await pressButton("Floating Bold")
    const strong = await until("the new <strong>", () => elements("strong"), (value) => value.some((entry) => entry.text === "natively"))
    const word = strong.find((entry) => entry.text === "natively")!.node.bounds!
    const toolbar = await toolbarBounds()
    // Playground placement: the toolbar's left edge sits 5px left of the range, and its bottom 10px above it.
    assert(Math.abs(toolbar.x - (word.x - 5)) <= 3, `toolbar.x ${toolbar.x} vs the word's ${word.x} - 5`)
    assert(Math.abs(word.y - (toolbar.y + toolbar.height) - 10) <= 5, `toolbar bottom ${toolbar.y + toolbar.height} vs the word's top ${word.y}`)
  })

  await step("Undo takes the bold away, Redo brings it back", async () => {
    await pressButton("Undo")
    await until("bold undone", () => elements("strong"), (value) => !value.some((entry) => entry.text === "natively"))
    await pressButton("Redo")
    await until("bold redone", () => elements("strong"), (value) => value.some((entry) => entry.text === "natively"))
    await pressButton("Undo")
    await until("bold undone again", () => elements("strong"), (value) => !value.some((entry) => entry.text === "natively"))
  })

  await step("a bulleted list", async () => {
    await keys("ArrowRight End Enter")
    await type("alpha")
    await pressButton("Bulleted list")
    await keys("Enter")
    await type("beta")
    const items = await until("two new list items", () => elements("li"), (value) => value.length === 8)
    equalTexts(items.slice(6).map((entry) => entry.text), ["alpha", "beta"])
    assert((await elements("ul")).length === 2, "a second <ul>")
  })

  await step("a link on the selected word", async () => {
    await keys("Alt+Shift+ArrowLeft")
    await until("the floating toolbar", toolbarBounds, () => true)
    await pressButton("Floating Link")
    const url = app.getByTestId("link-url")
    await url.waitFor({ timeoutMs: 4_000 })
    await url.fill("https://ghia.dev")
    await pressButton("link-apply")
    const links = await until("the new link", () => elements("a"), (value) => value.some((entry) => entry.text === "beta"))
    assert(links.length === 2, `two links, got ${links.length}`)
    await shot("3-list-and-link")
  })

  await step("clicking into the editor elsewhere hides the floating toolbar", async () => {
    await keys("Alt+Shift+ArrowLeft")
    await until("the floating toolbar", toolbarBounds, () => true)
    const first = (await elements("p"))[0].node
    assert(first.bounds !== undefined, "the first paragraph has bounds")
    await app.mouse.click({ x: first.bounds!.x + 20, y: first.bounds!.y + first.bounds!.height / 2 })
    await until("the toolbar gone", () => app.getByTestId("floating-toolbar").count(), (count) => count === 0)
    // The handler that placed the toolbar still runs after it is gone: the editor takes a key and the toolbar stays away.
    await keys("ArrowRight")
    assert((await app.getByTestId("floating-toolbar").count()) === 0, "the toolbar came back")
    await shot("4-toolbar-hidden")
  })

  console.log(`[automation] ${flavor}: done, ${failures} failure(s)`)
} finally {
  await app.close()
}

function equalTexts(actual: string[], expected: string[]): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

process.exit(failures === 0 ? 0 : 1)
