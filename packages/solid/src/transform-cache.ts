// Babel is the heaviest thing a Solid app loads at startup (55-73 MB of footprint that Bun's allocator keeps),
// and every launch used to transform every JSX/TSX file again. Each source path gets one cache entry, so the
// cache is bounded by the number of files and an edit overwrites its own entry.
import { createHash, randomBytes } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { join } from "node:path"
import type { transformAsync } from "@babel/core"

export type SourceTransform = (code: string, filename: string) => Promise<string>

export const defaultCacheDir = join(homedir(), "Library/Caches/ghia/solid-transform")

type Presets = NonNullable<Parameters<typeof transformAsync>[1]>["presets"]

interface PresetPlan {
  solid: { generate: "universal"; moduleName: "@ghia/solid" } | null
  typescript: boolean
}

function presetPlan(filename: string): PresetPlan {
  return {
    solid: /\.[cm]?[jt]sx$/.test(filename) ? { generate: "universal", moduleName: "@ghia/solid" } : null,
    typescript: /\.[cm]?tsx?$/.test(filename),
  }
}

export async function babelTransform(code: string, filename: string): Promise<string> {
  const plan = presetPlan(filename)
  const babel = await import("@babel/core")
  const presets: Presets = []
  if (plan.solid) presets.push([(await import("babel-preset-solid")).default, plan.solid])
  if (plan.typescript) presets.push([(await import("@babel/preset-typescript")).default])
  const result = await babel.transformAsync(code, { filename, configFile: false, babelrc: false, presets })
  if (result?.code == null) throw new Error(`Babel produced no code for ${filename}`)
  return result.code
}

const ownRequire = createRequire(import.meta.url)
let versions: Promise<string[]> | undefined

function packageVersion(specifier: string): Promise<string> {
  return readFile(ownRequire.resolve(`${specifier}/package.json`), "utf8").then(
    (text) => `${specifier}@${JSON.parse(text).version}`
  )
}

// Read from the package.json files rather than loading the packages: a hit must not load Babel.
export async function transformIdentity(filename: string): Promise<string> {
  versions ??= Promise.all(
    ["../package.json", "@babel/core", "babel-preset-solid", "@babel/preset-typescript"].map((specifier) =>
      specifier.startsWith(".")
        ? readFile(new URL(specifier, import.meta.url), "utf8").then((text) => `@ghia/solid@${JSON.parse(text).version}`)
        : packageVersion(specifier)
    )
  )
  return JSON.stringify([...(await versions), presetPlan(filename)])
}

async function readEntry(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch {
    // A missing or unreadable entry is a miss; the transform below produces the real result.
    return undefined
  }
}

let warnedAboutWrite = false

export interface CachedTransformOptions {
  dir: string
  filename: string
  source: string
  identity: string
  transform: SourceTransform
}

export async function cachedTransform(options: CachedTransformOptions): Promise<string> {
  const key = createHash("sha256").update(options.filename).digest("hex")
  const validity = createHash("sha256").update(options.identity).update("\0").update(options.source).digest("hex")
  const path = join(options.dir, key)
  const entry = await readEntry(path)
  if (entry !== undefined && entry.startsWith(`${validity}\n`)) return entry.slice(validity.length + 1)

  const code = await options.transform(options.source, options.filename)
  const temp = join(options.dir, `${key}.${randomBytes(6).toString("hex")}.tmp`)
  try {
    await mkdir(options.dir, { recursive: true })
    await writeFile(temp, `${validity}\n${code}`)
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    if (!warnedAboutWrite) {
      warnedAboutWrite = true
      console.warn(`@ghia/solid: cannot write the transform cache in ${options.dir}`, error)
    }
  }
  return code
}
