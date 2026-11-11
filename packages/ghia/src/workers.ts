import { createHash } from "node:crypto"
import { basename, extname, relative, sep } from "node:path"

const QUOTED_SPEC = "(?:(?!\\$\\{)[^'\"`\\n])+"
// Like Vite's `workerImportMetaUrlRE`: `new Worker(new URL("<relative literal>", import.meta.url)`. The options argument of
// `Worker` is not part of the match, so it stays as written.
const WORKER_URL = new RegExp(
  `(new\\s+Worker\\s*\\(\\s*new\\s+URL\\s*\\(\\s*)(['"\`])(\\.{1,2}/${QUOTED_SPEC})\\2(\\s*,\\s*import\\.meta\\.url\\s*\\))`,
  "g"
)
const WORKER_HINT = /new\s+Worker\s*\(/

export type WorkerBuildContext = {
  /** The Vite root: the Worker's file name is derived from its path relative to it. */
  readonly root: string
  /** Resolves `specifier` from the module `importer`, to an absolute file path. */
  resolve(specifier: string, importer: string): Promise<string | undefined>
  /** Adds the file as an entry chunk of the build, written to `fileName` in the output directory. */
  emit(file: string, fileName: string): void
}

/**
 * Finds `new Worker(new URL("./file.ts", import.meta.url))` in a module and turns each Worker file
 * into an entry of its own, named `<stem>-<hash>.worker.js` in the flat output directory next to
 * `main.js` and `server.js`, which is where the compiled executable looks for its Workers.
 * Returns the rewritten code, or undefined when `code` starts no Worker from a relative URL
 * literal. Only literals change, so the lines stay where they were.
 */
export async function rewriteWorkerUrls(context: WorkerBuildContext, code: string, id: string): Promise<string | undefined> {
  if (isVirtual(id) || !WORKER_HINT.test(code)) return undefined
  const importer = id.split("?")[0]
  const matches = [...code.matchAll(WORKER_URL)]
  if (matches.length === 0) return undefined

  let rewritten = ""
  let last = 0
  for (const match of matches) {
    const specifier = match[3]
    const file = await context.resolve(specifier, importer)
    if (file === undefined) throw new Error(`Cannot resolve the Worker file "${specifier}" imported from ${importer}`)
    const fileName = workerFileName(file, context.root)
    context.emit(file, fileName)
    rewritten += code.slice(last, match.index) + `${match[1]}"./${fileName}"${match[4]}`
    last = match.index + match[0].length
  }
  return rewritten + code.slice(last)
}

/** The hash of the root-relative path keeps two Workers with one stem apart, in every environment build and without shared state. */
function workerFileName(file: string, root: string): string {
  const path = relative(root, file).split(sep).join("/")
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 8)
  return `${basename(file, extname(file))}-${hash}.worker.js`
}

function isVirtual(id: string): boolean {
  return id.startsWith("\0") || id.startsWith("virtual:")
}
