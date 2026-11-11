import { basename, extname } from "node:path"

const QUOTED_SPEC = "(?:(?!\\$\\{)[^'\"`\\n])+"
// Like Vite's `workerImportMetaUrlRE`: `new Worker(new URL("<relative literal>", import.meta.url)`. The options argument of
// `Worker` is not part of the match, so it stays as written.
const WORKER_URL = new RegExp(
  `(new\\s+Worker\\s*\\(\\s*new\\s+URL\\s*\\(\\s*)(['"\`])(\\.{1,2}/${QUOTED_SPEC})\\2(\\s*,\\s*import\\.meta\\.url\\s*\\))`,
  "g"
)
const WORKER_HINT = /new\s+Worker\s*\(/

export type WorkerBuildContext = {
  /** Resolves `specifier` from the module `importer`, to an absolute file path. */
  resolve(specifier: string, importer: string): Promise<string | undefined>
  /** Adds the file as an entry chunk of the build, written to `fileName` in the output directory. */
  emit(file: string, fileName: string): void
}

/**
 * Finds `new Worker(new URL("./file.ts", import.meta.url))` in the modules of a build and turns each
 * Worker file into an entry of its own, named `<stem>.worker.js` in the flat output directory next to
 * `main.js` and `server.js`, which is where the compiled executable looks for its Workers.
 */
export class WorkerFiles {
  readonly #names = new Map<string, string>()
  readonly #taken = new Set<string>()
  readonly #byEnvironment = new Map<string, Set<string>>()

  /** The file names emitted by `environment`, in the order they were found. */
  forEnvironment(environment: string): readonly string[] {
    const names = this.#byEnvironment.get(environment)
    return names === undefined ? [] : [...names]
  }

  /** The rewritten code, or undefined when `code` starts no Worker from a relative URL literal. Only literals change, so the lines stay where they were. */
  async rewrite(environment: string, context: WorkerBuildContext, code: string, id: string): Promise<string | undefined> {
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
      const fileName = this.#nameFor(file)
      context.emit(file, fileName)
      this.#remember(environment, fileName)
      const start = match.index
      rewritten += code.slice(last, start) + `${match[1]}"./${fileName}"${match[4]}`
      last = start + match[0].length
    }
    return rewritten + code.slice(last)
  }

  #nameFor(file: string): string {
    const existing = this.#names.get(file)
    if (existing !== undefined) return existing
    const stem = basename(file, extname(file))
    let fileName = `${stem}.worker.js`
    for (let attempt = 2; this.#taken.has(fileName); attempt++) fileName = `${stem}-${attempt}.worker.js`
    this.#taken.add(fileName)
    this.#names.set(file, fileName)
    return fileName
  }

  #remember(environment: string, fileName: string): void {
    const names = this.#byEnvironment.get(environment)
    if (names === undefined) this.#byEnvironment.set(environment, new Set([fileName]))
    else names.add(fileName)
  }
}

function isVirtual(id: string): boolean {
  return id.startsWith("\0") || id.startsWith("virtual:")
}
