import { readFileSync } from "node:fs"

/** The pnpm-installed path and the workspace link both end in one of these. */
export const NATIVE_LOADER_FILTER = /(@ghia\/native|packages\/native)\/index\.js$/

const REQUIRE_LINE = "const require = createRequire(import.meta.url)"

/**
 * Bun's bundler embeds an addon only for a free `require("./x.node")`. The napi-rs loader gets its
 * `require` from `createRequire(import.meta.url)`, which the bundler leaves alone, so the compiled
 * binary would look for the addon on disk. Dropping that line makes `require` the bundler's own.
 */
export function patchNativeLoader(source: string, path: string): string {
  if (!source.includes(REQUIRE_LINE)) {
    throw new Error(
      `${path} no longer contains \`${REQUIRE_LINE}\`: the napi-rs loader changed shape, so ghia cannot embed the native addon in the compiled binary`
    )
  }
  return source.replace(`${REQUIRE_LINE}\n`, "").replace(REQUIRE_LINE, "")
}

export const nativeLoaderPlugin: Bun.BunPlugin = {
  name: "ghia-native-loader",
  setup(builder) {
    builder.onLoad({ filter: NATIVE_LOADER_FILTER }, (args) => ({
      contents: patchNativeLoader(readFileSync(args.path, "utf8"), args.path),
      loader: "js",
    }))
  },
}

export interface CompileOptions {
  /** Absolute paths: the UI bundle first, then the server bundle when the app has one. */
  readonly entrypoints: readonly string[]
  readonly outfile: string
}

/** Bundles the build output into one executable that carries Bun and the native addon. The server bundle is an entrypoint too, because the built UI starts its Worker from the executable's own filesystem. */
export async function compile(options: CompileOptions): Promise<void> {
  const result = await Bun.build({
    entrypoints: [...options.entrypoints],
    compile: { outfile: options.outfile },
    format: "esm",
    bytecode: true,
    minify: true,
    plugins: [nativeLoaderPlugin],
  })
  if (!result.success) {
    throw new Error(`Compiling ${options.outfile} failed:\n${result.logs.join("\n")}`)
  }
}
