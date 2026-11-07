import type { Plugin } from "vite"
import { PLUGIN_NAME, type GhiaPluginApi } from "./plugin.js"

export function findPluginApi(plugins: readonly Plugin[]): GhiaPluginApi {
  const plugin = plugins.find((candidate) => candidate.name === PLUGIN_NAME)
  if (plugin === undefined) {
    throw new Error(`Add ghia() from "ghia" to the plugins of your Vite config`)
  }
  return plugin.api as GhiaPluginApi
}

export function requireEntry(api: GhiaPluginApi, command: string): string {
  if (api.entry === undefined) {
    throw new Error(`ghia ${command} needs an entry: set ghia({ entry: "<entry file>" }) in your Vite config`)
  }
  return api.entry
}

// A test that spawns the CLI hands down vitest's marker, and ghia() would then configure for tests.
export function clearVitestMarker(): void {
  delete process.env.VITEST
}
