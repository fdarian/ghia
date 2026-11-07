import type { EnvironmentOptions, Plugin } from "vite"
import { ENVIRONMENT_NAME, PLUGIN_NAME, type GhiaPluginApi } from "./plugin.js"

export function findPluginApi(plugins: readonly Plugin[]): GhiaPluginApi {
  const plugin = plugins.find((candidate) => candidate.name === PLUGIN_NAME)
  if (plugin === undefined) {
    throw new Error(`Add ghia() from "ghia" to the plugins of your Vite config`)
  }
  return plugin.api as GhiaPluginApi
}

export function requireEntry(api: GhiaPluginApi, command: string): string {
  if (api.entry === undefined) {
    throw new Error(`ghia ${command} needs an entry: pass it as an argument (ghia ${command} <entry>) or set ghia({ entry: "<entry file>" }) in your Vite config`)
  }
  return api.entry
}

// A test that spawns the CLI hands down vitest's marker, and ghia() would then configure for tests.
export function clearVitestMarker(): void {
  delete process.env.VITEST
}

/** The inline config that makes `entry` the input of the `ghia` environment, over the `entry` option of `ghia()`. */
export function entryEnvironments(entry: string | undefined): Record<string, EnvironmentOptions> | undefined {
  if (entry === undefined) return undefined
  return { [ENVIRONMENT_NAME]: { build: { rolldownOptions: { input: entry } } } }
}
