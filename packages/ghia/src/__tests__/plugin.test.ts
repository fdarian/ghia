import { expect, test } from "bun:test"
import type { Plugin } from "vite"
import { ghia } from "../../dist/index.js"

function clientDefaults(userValue: boolean | undefined) {
  const plugin = ghia({ entry: "main.ts" })[0] as Plugin
  const hook = plugin.configEnvironment
  if (typeof hook !== "function") throw new Error("configEnvironment is a function hook")
  const environment = userValue === undefined ? {} : { optimizeDeps: { noDiscovery: userValue } }
  return hook.call({} as never, "client", environment, { command: "serve", mode: "development" })
}

test("the client environment skips dependency discovery unless the config says otherwise", () => {
  expect(clientDefaults(undefined)).toEqual({ optimizeDeps: { noDiscovery: true } })
  expect(clientDefaults(false)).toBeUndefined()
  expect(clientDefaults(true)).toBeUndefined()
})
