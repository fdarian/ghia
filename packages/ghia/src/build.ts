import { join, resolve } from "node:path"
import { createBuilder } from "vite"
import { compile } from "./compile.js"
import { ENTRY_FILE_NAMES, ENVIRONMENT_NAME, SERVER_ENVIRONMENT_NAME } from "./plugin.js"
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
  await builder.build(environment)
  const serverEnvironment = builder.environments[SERVER_ENVIRONMENT_NAME]
  // After the `ghia` build, which empties the output directory.
  if (serverEnvironment !== undefined) await builder.build(serverEnvironment)

  if (options.compile === false) return
  const outDir = resolve(builder.config.root, environment.config.build.outDir)
  const entrypoints = [join(outDir, ENTRY_FILE_NAMES[ENVIRONMENT_NAME])]
  const workerFiles = api.workerFiles(ENVIRONMENT_NAME).map((name) => join(outDir, name))
  if (serverEnvironment !== undefined) {
    const serverOutDir = resolve(builder.config.root, serverEnvironment.config.build.outDir)
    entrypoints.push(join(serverOutDir, ENTRY_FILE_NAMES[SERVER_ENVIRONMENT_NAME]))
    workerFiles.push(...api.workerFiles(SERVER_ENVIRONMENT_NAME).map((name) => join(serverOutDir, name)))
  }
  await compile({ entrypoints: [...entrypoints, ...workerFiles], outfile: api.compileOutfile ?? join(outDir, "app") })
}
