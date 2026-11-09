// Prints what the Solid compiler makes of a .tsx file with the options packages/solid/src/vite.ts gives vite-plugin-solid
// (`generate: "universal"`, `moduleName: "@ghia/solid"`, no HMR). Babel and the preset are vite-plugin-solid's own dependencies.
//   node compile.mjs Detail.tsx > /tmp/ghia-templates/detail.compiled.js
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const input = process.argv[2]
if (!input) throw new Error("usage: node compile.mjs <file.tsx>")
const plugin = realpathSync(resolve(import.meta.dirname, "../../../packages/solid/node_modules/vite-plugin-solid"))
const pluginRequire = createRequire(resolve(plugin, "index.js"))
const babel = pluginRequire("@babel/core")
const preset = pluginRequire("babel-preset-solid")
const file = resolve(input)
const result = await babel.transformAsync(readFileSync(file, "utf8"), {
  filename: file,
  presets: [[preset, { generate: "universal", hydratable: false, moduleName: "@ghia/solid" }]],
  ast: false,
  sourceMaps: false,
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ["jsx", "typescript"] },
})
console.log(result.code)
