import { createHash } from "node:crypto"
import { basename, extname, relative, sep } from "node:path"
import { stripLiteral } from "strip-literal"
import { createBuilder, type ResolvedConfig } from "vite"

// Matched on the code with comments and string contents blanked (`stripLiteral`), so a `new Worker(...)` in a JSDoc example or a
// string is not a Worker. A literal is a quote pair around spaces there; the specifier is read back from the original code. Like
// Vite's `workerImportMetaUrlRE`, the options argument of `Worker` is not part of the match and stays as written.
const WORKER_URL = /(new\s+Worker\s*\(\s*new\s+URL\s*\(\s*)(['"`])( +)\2(\s*,\s*import\.meta\.url\s*(?:,\s*)?\))/g
const WORKER_HINT = /new\s+Worker\s*\(/
export const WORKER_FILE_SUFFIX = ".worker.js"
const RELATIVE = /^\.{1,2}\//

/** The key of the inline config of a Worker's own build, which the `ghia` plugin reads (see `readWorkerBuild`). */
export const WORKER_BUILD_KEY = "ghiaWorkerBuild"

export type WorkerBuild = {
  /** The Worker file this build bundles. */
  readonly file: string
  /** The Worker files whose builds are running above this one, to refuse a cycle. */
  readonly chain: readonly string[]
}

export type WorkerBuildContext = {
  /** The Vite root: the Worker's file name is derived from its path relative to it. */
  readonly root: string
  /** The Vite environment that is being built: one file started from both environments is two Workers. */
  readonly environmentName: string
  /** Resolves `specifier` from the module `importer`, to an absolute file path. */
  resolve(specifier: string, importer: string): Promise<string | undefined>
  /** Bundles the file on its own and writes it to `fileName` in the output directory, once however many modules start it. */
  emit(file: string, fileName: string): Promise<void>
  warn(message: string): void
}

/**
 * Finds `new Worker(new URL("./file.ts", import.meta.url))` in a module and points each URL at the
 * Worker file's own bundle, `<stem>-<hash>.worker.js` in the flat output directory next to `main.js`
 * and `server.js`, which is where the compiled executable looks for its Workers.
 * Returns the rewritten code, or undefined when `code` starts no Worker from a relative URL
 * literal. Only literals change, so the lines stay where they were.
 */
export async function rewriteWorkerUrls(context: WorkerBuildContext, code: string, id: string): Promise<string | undefined> {
  if (isVirtual(id) || !WORKER_HINT.test(code)) return undefined
  const importer = id.split("?")[0]
  const cleaned = stripLiteral(code)
  const matches = [...cleaned.matchAll(WORKER_URL)]
  if (matches.length === 0) return undefined

  let rewritten = ""
  let last = 0
  for (const match of matches) {
    const literalStart = match.index + match[1].length
    const specifier = code.slice(literalStart + 1, literalStart + 1 + match[3].length)
    if (!RELATIVE.test(specifier) || /[\n"'`]|\$\{/.test(specifier)) continue
    const file = await context.resolve(specifier, importer)
    if (file === undefined) {
      const message = `Cannot resolve the Worker file "${specifier}" imported from ${importer}`
      if (!importer.includes("/node_modules/")) throw new Error(message)
      context.warn(`${message}; it stays as written`)
      continue
    }
    const fileName = workerFileName(file, context.root, context.environmentName)
    await context.emit(file, fileName)
    rewritten += code.slice(last, match.index) + `${match[1]}"./${fileName}"${match[4]}`
    last = match.index + match[0].length
  }
  return last === 0 ? undefined : rewritten + code.slice(last)
}

/** The hash keeps two Workers with one stem apart, and one file started from both environments, which share the output directory, in two files. */
function workerFileName(file: string, root: string, environmentName: string): string {
  const path = relative(root, file).split(sep).join("/")
  const hash = createHash("sha256").update(`${environmentName}:${path}`).digest("hex").slice(0, 8)
  return `${basename(file, extname(file))}-${hash}${WORKER_FILE_SUFFIX}`
}

function isVirtual(id: string): boolean {
  return id.startsWith("\0") || id.startsWith("virtual:")
}

type Emitter = { emitFile(file: { type: "prebuilt-chunk"; fileName: string; code: string }): string }

/**
 * Bundles each Worker file as a build of its own, as Vite's `bundleWorkerEntry` does, so a module
 * that the app and a Worker both import is in both bundles instead of in a chunk the app loads
 * before `@ghia/native/dom-globals`. The build is of the same environment, from the same config file, and its plugin builds
 * the Workers that this Worker starts in turn. The bundle is emitted as a prebuilt chunk: Vite drops every emitted asset
 * from the build of a `consumer: "server"` environment (`build.emitAssets`), and a prebuilt chunk is written as it is.
 */
export class WorkerBundler {
  private readonly bundles = new Map<string, Promise<readonly BundledFile[]>>()
  private readonly emitted = new Set<string>()

  constructor(
    private readonly config: ResolvedConfig,
    private readonly chain: readonly string[]
  ) {}

  reset(): void {
    this.bundles.clear()
    this.emitted.clear()
  }

  async emit(emitter: Emitter, environmentName: string, file: string, fileName: string): Promise<void> {
    if (this.chain.includes(file)) throw new Error(`The Worker ${file} starts itself through ${[...this.chain, file].join(" -> ")}`)
    const key = `${environmentName}:${file}`
    let bundle = this.bundles.get(key)
    if (bundle === undefined) {
      bundle = this.build(environmentName, file, fileName)
      this.bundles.set(key, bundle)
    }
    for (const item of await bundle) {
      if (this.emitted.has(item.fileName)) continue
      this.emitted.add(item.fileName)
      emitter.emitFile({ type: "prebuilt-chunk", fileName: item.fileName, code: item.code })
    }
  }

  private async build(environmentName: string, file: string, fileName: string): Promise<readonly BundledFile[]> {
    if (this.config.configFile === undefined) {
      throw new Error(`Bundling the Worker ${file} runs a second build from the Vite config file, and this build has none`)
    }
    const workerBuild: WorkerBuild = { file, chain: [...this.chain, file] }
    const builder = await createBuilder({
      configFile: this.config.configFile,
      root: this.config.root,
      mode: this.config.mode,
      logLevel: "warn",
      environments: {
        [environmentName]: {
          build: { write: false, rolldownOptions: { input: file, output: { codeSplitting: false } } },
        },
      },
      [WORKER_BUILD_KEY]: workerBuild,
    } as Parameters<typeof createBuilder>[0])
    const environment = builder.environments[environmentName]
    if (environment === undefined) throw new Error(`The "${environmentName}" environment is not defined in ${this.config.configFile}`)
    const result = await builder.build(environment)
    const outputs = Array.isArray(result) ? result : [result]
    const files: BundledFile[] = []
    for (const output of outputs) {
      if (!("output" in output)) throw new Error(`The build of the Worker ${file} returned a watcher instead of its output`)
      for (const item of output.output) {
        if (item.type !== "chunk") continue
        if (item.isEntry) files.push({ fileName, code: item.code })
        else if (item.fileName.endsWith(WORKER_FILE_SUFFIX)) files.push({ fileName: item.fileName, code: item.code })
      }
    }
    if (!files.some((item) => item.fileName === fileName)) throw new Error(`The build of the Worker ${file} has no entry chunk`)
    return files
  }
}

type BundledFile = { fileName: string; code: string }

/** The Worker build that an inline config (or the user config Vite merged it into) asks for, undefined in the app's own builds. */
export function readWorkerBuild(inlineConfig: object): WorkerBuild | undefined {
  const value = (inlineConfig as Record<string, unknown>)[WORKER_BUILD_KEY]
  return value === undefined ? undefined : (value as WorkerBuild)
}
