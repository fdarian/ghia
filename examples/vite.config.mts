import { defineConfig, type Plugin } from "vite"
import { ghia } from "ghia"
import { react } from "@ghia/react/vite"
import { solid } from "@ghia/solid/vite"
import stylex from "@stylexjs/unplugin"

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

// StyleX collects the CSS of the files that import it (and only those: the plugin skips every other file). It serves that CSS
// to a page over HTTP, which `ghia dev` (a Vite server in middleware mode, no listener) never reaches, so the same CSS the
// plugin would write at build time is handed over as a module: `import css from "virtual:stylex-css"` in the file that renders
// it, after the StyleX files it styles are imported.
const stylexPlugin = stylex.vite({ useCSSLayers: true })
const STYLEX_CSS_ID = "virtual:stylex-css"
function stylexCss(): Plugin {
  return {
    name: "examples:stylex-css",
    resolveId(source) {
      if (source === STYLEX_CSS_ID) return `\0${STYLEX_CSS_ID}`
    },
    load(id) {
      if (id !== `\0${STYLEX_CSS_ID}`) return
      const css: string = stylexPlugin.__stylexCollectCss()
      if (css === "") throw new Error(`${STYLEX_CSS_ID} was imported before any StyleX file was transformed`)
      return `export default ${JSON.stringify(css)}`
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
    stylexPlugin,
    stylexCss(),
    react({ exclude: [/\/node_modules\//, solidFiles] }),
    solid({ include: solidFiles }),
  ],
})
