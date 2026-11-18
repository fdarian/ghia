// Plain JavaScript, copied to dist/ as it is (`copy` in tsdown.config.ts), because the bundler that
// builds the rest rewrites a free `require` into a `createRequire` helper, and `ghia build`'s
// compile (Bun's bundler) embeds a module only for a literal `require("parse5")`, which it then
// evaluates on the first call and not at startup.

let loaded

/**
 * parse5 is read on the first call and kept. Parsing markup is rare and the module is ~300 KB of
 * JavaScript, so an app that never parses pays for none of it at startup. Every user of parse5
 * goes through this: a static `import "parse5"` anywhere in the graph loads it with the app.
 *
 * Node's ESM has no `require`, so `createRequire` stands in there; `process.getBuiltinModule` and
 * not an `import` keeps `node:module` out of the web build.
 */
export function parse5() {
  if (loaded !== undefined) return loaded
  loaded =
    typeof require === "function"
      ? require("parse5")
      : process.getBuiltinModule("node:module").createRequire(import.meta.url)("parse5")
  return loaded
}

/** Whether `parse5()` has been called: what the test of the lazy load reads. */
export function isParse5Loaded() {
  return loaded !== undefined
}
