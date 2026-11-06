#!/usr/bin/env bun
import { parseArgs } from "node:util"
import {
  createBuilder,
  createServer,
  isRunnableDevEnvironment,
  type Plugin,
  type ViteDevServer,
} from "vite"
import { ENVIRONMENT_NAME, PLUGIN_NAME, type GhiaPluginApi } from "./plugin.js"

const USAGE = `Usage: ghia <dev|build> [--config <file>]`

function findPluginApi(plugins: readonly Plugin[]): GhiaPluginApi {
  const plugin = plugins.find((candidate) => candidate.name === PLUGIN_NAME)
  if (plugin === undefined) {
    throw new Error(`Add ghia() from "@ghia/vite" to the plugins of your Vite config`)
  }
  return plugin.api as GhiaPluginApi
}

async function dev(configFile: string | undefined): Promise<void> {
  const server = await createServer({
    configFile,
    appType: "custom",
    server: { middlewareMode: true, ws: false },
  })
  const environment = server.environments[ENVIRONMENT_NAME]
  if (environment === undefined || !isRunnableDevEnvironment(environment)) {
    await server.close()
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not a runnable dev environment`)
  }
  stopOnSignal(server)

  // A full reload makes the runner clear its module cache and re-import the entry by itself,
  // so `render()` runs again; it is built to be re-run on the same window.
  try {
    await environment.runner.import(findPluginApi(server.config.plugins).entry)
  } catch (error) {
    await server.close()
    throw error
  }
}

function stopOnSignal(server: ViteDevServer): void {
  const stop = () => {
    server.close().finally(() => process.exit(0))
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

async function build(configFile: string | undefined): Promise<void> {
  const builder = await createBuilder({ configFile })
  const environment = builder.environments[ENVIRONMENT_NAME]
  if (environment === undefined) {
    throw new Error(`The "${ENVIRONMENT_NAME}" environment is not defined; add ghia() to your Vite config`)
  }
  await builder.build(environment)
}

async function main(): Promise<void> {
  if (!process.versions.bun) {
    throw new Error("ghia runs the app inside its own process with the native addon, so it needs Bun")
  }
  const args = parseArgs({
    allowPositionals: true,
    options: { config: { type: "string", short: "c" } },
  })
  const command = args.positionals[0]
  if (command === "dev") await dev(args.values.config)
  else if (command === "build") await build(args.values.config)
  else throw new Error(USAGE)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
