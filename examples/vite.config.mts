import { defineConfig, type Plugin } from "vite"
import { ghia } from "ghia"
import { react } from "@ghia/react/vite"
import { solid } from "@ghia/solid/vite"

// Both frameworks compile .tsx, and they cannot both claim a file: Solid takes examples/solid,
// React takes every other example. They share one `ghia` environment, so the split is by file.
const solidFiles = `${import.meta.dirname}/solid/**`

/** `import icon from "./icon.svg" with { type: "text" }` is what Bun reads; Vite reads `?raw`. */
function textImports(): Plugin {
  return {
    name: "examples:text-imports",
    resolveId: {
      order: "pre",
      async handler(source, importer, options) {
        // An entry point has no import attributes.
        if (options.attributes?.type !== "text") return
        return this.resolve(`${source}?raw`, importer, options)
      },
    },
  }
}

// The entry comes from the command line: `ghia dev chat.main.tsx`, `ghia dev solid/main.tsx`.
export default defineConfig({
  environments: {
    ghia: {
      resolve: {
        // The `ghia` environment inlines every dependency, which suits packages written for a page.
        // safe-mdx's tree is written for Node: a CommonJS member Vite's module runner cannot run,
        // and a `browser` build of decode-named-character-reference that calls document.createElement.
        external: ["safe-mdx"],
      },
    },
  },
  plugins: [
    ghia(),
    textImports(),
    react({ exclude: [/\/node_modules\//, solidFiles] }),
    solid({ include: solidFiles }),
  ],
})
