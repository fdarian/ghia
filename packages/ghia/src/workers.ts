import { createHash } from "node:crypto"
import { basename, extname, relative, sep } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { stripLiteral } from "strip-literal"
import { createBuilder, type Plugin, type Rolldown, type ResolvedConfig } from "vite"

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

type Emitter = { emitFile(file: Rolldown.EmittedPrebuiltChunk | Rolldown.EmittedAsset): string }

type BundledFile = { type: "chunk" | "asset"; fileName: string; content: string }

const SOURCE_MAP_COMMENT = /\/\/# sourceMappingURL=\S+\s*$/

/**
 * Finds `new Worker(new URL("./file.ts", import.meta.url))` in the modules of a build and bundles each
 * Worker file (see `WorkerBundler`). A plugin of its own and not part of `ghia()`'s main one, because it
 * reads the code after the other plugins' TS and JSX transforms, which the entry's `dom-globals` import
 * (a `pre` transform) must not wait for. It does nothing in dev, where Bun runs a Worker from its source file,
 * and under vitest.
 */
export function workerPlugin(environmentNames: readonly string[]): Plugin {
  const underVitest = process.env.VITEST !== undefined
  let bundler: WorkerBundler
  return {
    name: "ghia:workers",
    apply: "build",
    applyToEnvironment: (environment) => !underVitest && environmentNames.includes(environment.name),
    configResolved(config) {
      bundler = new WorkerBundler(config, readWorkerBuild(config.inlineConfig)?.chain ?? [])
    },
    buildStart() {
      bundler.reset()
    },
    transform: {
      filter: { id: { exclude: /^(\0|virtual:)/ }, code: WORKER_HINT },
      async handler(code, id) {
        const environment = this.environment
        const rewritten = await rewriteWorkerUrls(
          {
            root: environment.config.root,
            environmentName: environment.name,
            resolve: async (specifier, importer) => (await this.resolve(specifier, importer))?.id,
            emit: (file, fileName) => bundler.emit(this, environment.name, file, fileName),
            warn: (message) => this.warn(message),
          },
          code,
          id
        )
        // Same line numbers as before: only literals change.
        return rewritten === undefined ? undefined : { code: rewritten, map: null }
      },
    },
  }
}

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
    // The Worker that is being built starts itself: its URL is its own file name, and there is nothing to build.
    if (file === this.chain.at(-1)) return
    if (this.chain.includes(file)) throw new Error(`The Worker ${file} starts itself through ${[...this.chain, file].join(" -> ")}`)
    for (const item of await this.bundleOf(environmentName, file, fileName)) {
      if (this.emitted.has(item.fileName)) continue
      this.emitted.add(item.fileName)
      emitter.emitFile(
        item.type === "asset"
          ? { type: "asset", fileName: item.fileName, source: item.content }
          : // `build.ts` hands the entry chunks to `Bun.build`, and a Worker is one.
            { type: "prebuilt-chunk", fileName: item.fileName, code: item.content, isEntry: true }
      )
    }
  }

  private bundleOf(environmentName: string, file: string, fileName: string): Promise<readonly BundledFile[]> {
    const key = `${environmentName}:${file}`
    const cached = this.bundles.get(key)
    if (cached !== undefined) return cached
    const bundle = this.build(environmentName, file, fileName)
    this.bundles.set(key, bundle)
    return bundle
  }

  private async build(environmentName: string, file: string, fileName: string): Promise<readonly BundledFile[]> {
    try {
      return await this.bundle(environmentName, file, fileName)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Bundling the Worker ${file} failed:\n${stripVTControlCharacters(reason)}`, { cause: error })
    }
  }

  private async bundle(environmentName: string, file: string, fileName: string): Promise<readonly BundledFile[]> {
    if (this.config.configFile === undefined) {
      throw new Error(`Bundling the Worker ${file} runs a second build from the Vite config file, and this build has none`)
    }
    const workerBuild: WorkerBuild = { file, chain: [...this.chain, file] }
    const builder = await createBuilder({
      configFile: this.config.configFile,
      root: this.config.root,
      mode: this.config.mode,
      logLevel: "warn",
      builder: { sharedConfigBuild: true },
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
        // The Workers this Worker starts come out of its build as the chunks (and source maps) they were emitted as.
        if (item.type === "asset") {
          if (item.fileName.endsWith(`${WORKER_FILE_SUFFIX}.map`)) files.push({ type: "asset", fileName: item.fileName, content: String(item.source) })
        } else if (item.fileName.endsWith(WORKER_FILE_SUFFIX)) {
          files.push({ type: "chunk", fileName: item.fileName, content: item.code })
        } else if (item.isEntry) {
          files.push({ type: "chunk", fileName, content: item.map == null ? item.code : pointSourceMapAt(item.code, fileName) })
          // Rolldown does not write the map of a prebuilt chunk, so it is emitted as a file of its own; Vite keeps `.js.map` assets in every environment.
          if (item.map != null) files.push({ type: "asset", fileName: `${fileName}.map`, content: JSON.stringify(item.map) })
        }
      }
    }
    if (!files.some((item) => item.type === "chunk" && item.fileName === fileName)) throw new Error(`The build of the Worker ${file} has no entry chunk`)
    return files
  }
}

/** The build names its entry `main.js` or `server.js`, and its source map comment says so; the file is written as `fileName`. */
function pointSourceMapAt(code: string, fileName: string): string {
  return code.replace(SOURCE_MAP_COMMENT, `//# sourceMappingURL=${fileName}.map\n`)
}

/** The Worker build that an inline config (or the user config Vite merged it into) asks for, undefined in the app's own builds. */
export function readWorkerBuild(inlineConfig: object): WorkerBuild | undefined {
  const value = (inlineConfig as Record<string, unknown>)[WORKER_BUILD_KEY]
  return value === undefined ? undefined : (value as WorkerBuild)
}
