import { join, resolve } from "node:path"
import { createBuilder, type BuildEnvironment, type ViteBuilder } from "vite"
import { compile } from "./compile.js"
import { ENTRY_FILE_NAMES, ENVIRONMENT_NAME, SERVER_ENVIRONMENT_NAME } from "./plugin.js"
import { WORKER_FILE_SUFFIX } from "./workers.js"
import { clearVitestMarker, entryEnvironments, findPluginApi, requireEntry } from "./plugin-api.js"
import type { BuildOptions } from "./options.js"

/**
 * Emits `dist/main.js` (and `dist/server.js` with the plugin's `server` option), which run with
 * plain `bun`, then compiles them into one executable unless `compile` is false.
 */
export async function build(options: BuildOptions = {}): Promise<void> {
  clearVitestMarker()
  const builder = await createBuilder({ configFile: options.configFile, root: options.root, environments: entryEnvironments(options.entry) })
  const api = findPluginApi(builder.config.plugins)
  requireEntry(api, "build")
  const environment = builder.environments[ENVIRONMENT_NAME]
  if (environment === undefined) {
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not defined; add ghia() to your Vite config`)
  }
  const entrypoints = entryChunkPaths(environment, await builder.build(environment))
  const serverEnvironment = builder.environments[SERVER_ENVIRONMENT_NAME]
  // After the `ghia` build, which empties the output directory.
  if (serverEnvironment !== undefined) entrypoints.push(...entryChunkPaths(serverEnvironment, await builder.build(serverEnvironment)))

  if (options.compile === false) return
  const outDir = resolve(builder.config.root, environment.config.build.outDir)
  await compile({ entrypoints, outfile: api.compileOutfile ?? join(outDir, "app") })
}

/** The files a build wrote that the compiled executable needs as entrypoints, as absolute paths, the environment's own entry first: its entry chunk, and the `.worker.js` chunk of each Worker it starts. */
function entryChunkPaths(environment: BuildEnvironment, result: Awaited<ReturnType<ViteBuilder["build"]>>): string[] {
  const outputs = Array.isArray(result) ? result : [result]
  const outDir = resolve(environment.config.root, environment.config.build.outDir)
  const entryFileName = ENTRY_FILE_NAMES[environment.name]
  const names = outputs.flatMap((output) => {
    if (!("output" in output)) throw new Error(`The "${environment.name}" build returned a watcher instead of its output`)
    return output.output.flatMap((item) => {
      const isWanted = item.type === "chunk" && (item.isEntry || item.fileName.endsWith(WORKER_FILE_SUFFIX))
      return isWanted ? [item.fileName] : []
    })
  })
  return [...names.filter((name) => name === entryFileName), ...names.filter((name) => name !== entryFileName)].map((name) => join(outDir, name))
}
