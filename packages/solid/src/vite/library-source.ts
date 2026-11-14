import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SERVER_ENVIRONMENT_NAME } from "ghia"
import type { Plugin, Rollup } from "vite"
import { WEB_EXPORTS } from "../web-exports.js"

const SOLID_WEB = "solid-js/web"
const OWN_PACKAGE = "@ghia/solid"
const WEB_EXPORT_NAMES: ReadonlySet<string> = new Set(WEB_EXPORTS)

type PackageManifest = {
  exports: Record<string, string | Record<string, string>>
}

let ownManifest: PackageManifest | undefined

function readOwnManifest(): PackageManifest {
  ownManifest ??= JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as PackageManifest
  return ownManifest
}

/**
 * The file of `@ghia/solid` or one of its subpaths, from this package's own `exports`. A Solid library
 * under `node_modules` cannot resolve `@ghia/solid` itself (it does not depend on it, and in a pnpm
 * store it is not beside it), and the app's copy is the one this plugin was loaded from.
 */
function resolveOwnPackage(id: string): string | undefined {
  if (id !== OWN_PACKAGE && !id.startsWith(`${OWN_PACKAGE}/`)) return undefined
  const entry = readOwnManifest().exports[id === OWN_PACKAGE ? "." : `.${id.slice(OWN_PACKAGE.length)}`]
  if (entry === undefined) return undefined
  const target = typeof entry === "string" ? entry : (entry.import ?? entry.default)
  return fileURLToPath(new URL(`../../${target}`, import.meta.url))
}

/** The names a module imports or re-exports from `solid-js/web` that `@ghia/solid/web` does not export. */
function unsupportedWebNames(program: ReturnType<Rollup.PluginContext["parse"]>): string[] {
  const unsupported = new Set<string>()
  const check = (name: string) => {
    if (!WEB_EXPORT_NAMES.has(name)) unsupported.add(name)
  }
  const nameOf = (node: { type: string; name?: string; value?: unknown }) =>
    node.type === "Identifier" ? String(node.name) : String(node.value)
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration" && statement.source.value === SOLID_WEB && statement.importKind !== "type") {
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type") check(nameOf(specifier.imported))
        else if (specifier.type === "ImportDefaultSpecifier") check("default")
      }
    } else if (
      statement.type === "ExportNamedDeclaration" &&
      statement.source?.value === SOLID_WEB &&
      statement.exportKind !== "type"
    ) {
      for (const specifier of statement.specifiers) check(nameOf(specifier.local))
    }
  }
  return [...unsupported]
}

/** The modules `transform` parses: JavaScript and TypeScript, with or without a `?query`. A CSS or JSON module that mentions `solid-js/web` is not JS. */
const SCRIPT_MODULE = /\.[cm]?[jt]sx?(?:\?|$)/

/** The parser's language for a script module: this runs before any compile, so a `.tsx` file is still TypeScript with JSX. */
function languageOf(file: string): "js" | "jsx" | "ts" | "tsx" {
  if (/\.[cm]?tsx$/.test(file)) return "tsx"
  if (/\.[cm]?ts$/.test(file)) return "ts"
  if (/\.jsx$/.test(file)) return "jsx"
  return "js"
}

/**
 * Lets Solid libraries that publish their JSX source (the `solid` export condition) run on Ghia's renderer:
 * `solid-js/web` is Solid's DOM renderer, which Ghia does not have, so it resolves to `@ghia/solid/web`.
 * Independent of the plugin that compiles the JSX.
 */
export function solidLibrarySource(): Plugin {
  return {
    name: "ghia:solid-libraries",
    applyToEnvironment: (environment) => environment.name !== SERVER_ENVIRONMENT_NAME,
    resolveId: {
      order: "pre",
      async handler(id, importer, resolveOptions) {
        const file = resolveOwnPackage(id === SOLID_WEB ? `${OWN_PACKAGE}/web` : id)
        if (file === undefined) return undefined
        return this.resolve(file, importer, { ...resolveOptions, skipSelf: true })
      },
    },
    transform: {
      // Before any other transform: Vite's import analysis rewrites `solid-js/web` to a file path.
      order: "pre",
      filter: { id: SCRIPT_MODULE, code: /solid-js\/web/ },
      handler(code, id) {
        const file = id.split("?")[0]
        // The plugin context's parser, not an import of `vite`: under vitest every dependency is inlined, and
        // Vite's own server code cannot be evaluated that way.
        const names = unsupportedWebNames(this.parse(code, { lang: languageOf(file) }))
        if (names.length === 0) return
        this.error(
          `${file} imports ${names.join(", ")} from "${SOLID_WEB}", which @ghia/solid/web does not export. ` +
            "The module ships code compiled for Solid's DOM renderer. Ghia compiles Solid libraries from their JSX source " +
            'and needs the library to publish it under the "solid" export condition.'
        )
      },
    },
  }
}
