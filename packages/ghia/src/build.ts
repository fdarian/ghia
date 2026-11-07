import { createBuilder } from "vite"
import { ENVIRONMENT_NAME, SERVER_ENVIRONMENT_NAME } from "./plugin.js"
import { clearVitestMarker, findPluginApi, requireEntry } from "./plugin-api.js"
import type { RunOptions } from "./options.js"

/** Emits `dist/main.js` (and `dist/server.js` with the plugin's `server` option), which run with plain `bun`. */
export async function build(options: RunOptions = {}): Promise<void> {
  clearVitestMarker()
  const builder = await createBuilder({ configFile: options.configFile, root: options.root })
  requireEntry(findPluginApi(builder.config.plugins), "build")
  const environment = builder.environments[ENVIRONMENT_NAME]
  if (environment === undefined) {
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not defined; add ghia() to your Vite config`)
  }
  await builder.build(environment)
  const serverEnvironment = builder.environments[SERVER_ENVIRONMENT_NAME]
  // After the `ghia` build, which empties the output directory.
  if (serverEnvironment !== undefined) await builder.build(serverEnvironment)
}
