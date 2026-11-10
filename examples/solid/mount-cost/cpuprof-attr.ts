// Attributes the JavaScript self time of phases js and ops (the samples under `profilePhaseJsAndOps` in profile.tsx) of a Bun
// `--cpu-prof` profile of the bundle `ghia build --no-compile solid/mount-cost/profile.tsx` makes (dist/main.js: one file, whose
// `// path` comments say which module a line range is).
//   bun cpuprof-attr.ts <profile.cpuprofile> <dist/main.js> [top=15]
import { readFileSync } from "node:fs"

type CallFrame = { functionName: string; url: string; lineNumber: number }
type ProfileNode = { id: number; callFrame: CallFrame; children?: number[] }
type Profile = { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }

const profilePath = process.argv[2]
const bundlePath = process.argv[3]
const top = Number(process.argv[4] ?? "15")
if (!profilePath || !bundlePath) throw new Error("usage: bun cpuprof-attr.ts <profile.cpuprofile> <dist/main.js> [top]")
const profile = JSON.parse(readFileSync(profilePath, "utf8")) as Profile

/** Line ranges (0-based, as the profile counts) of the modules in the bundle, from its `// path` comments. */
const regions = readFileSync(bundlePath, "utf8")
  .split("\n")
  .flatMap((line, index) => (line.startsWith("// ") && /\.(js|tsx|ts)$/.test(line) ? [{ from: index, path: line.slice(3) }] : []))

function bundleModule(line: number): string {
  let found = "(bundle prologue)"
  for (const region of regions) if (region.from <= line) found = region.path
  return found
}

/** JavaScriptCore reports a class's field initializers as an anonymous function at line 1 of the file; in this bundle the callers are the constructors of HostElement and HostText. */
const isFieldInitializer = (frame: CallFrame) => frame.url.endsWith("dist/main.js") && frame.functionName === "" && frame.lineNumber === 0

function category(frame: CallFrame): string {
  if (isFieldInitializer(frame)) return "packages/solid host.ts"
  if (frame.url.endsWith("dist/main.js")) {
    const module = bundleModule(frame.lineNumber)
    if (module.includes("/solid-js/")) return "solid-js runtime"
    if (module.endsWith("packages/solid/dist/host.js")) return "packages/solid host.ts"
    if (module.startsWith("solid/mount-cost/profile.tsx")) return "harness (profile.tsx)"
    if (module.startsWith("solid/mount-cost/")) return "compiled component code"
    return "packages/solid other (universal, root, presence)"
  }
  if (frame.url.includes("/packages/native/")) return "packages/native/js (mutations, wire, host)"
  return "other (builtins, native, runtime)"
}

const byId = new Map(profile.nodes.map((node) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)

const underPhase = new Map<number, boolean>()
function inPhase(id: number): boolean {
  const known = underPhase.get(id)
  if (known !== undefined) return known
  const node = byId.get(id)
  if (!node) throw new Error(`unknown node ${id}`)
  const parentId = parent.get(id)
  const result = node.callFrame.functionName === "profilePhaseJsAndOps" || (parentId !== undefined && inPhase(parentId))
  underPhase.set(id, result)
  return result
}

const byCategory = new Map<string, number>()
const byFunction = new Map<string, { micros: number; category: string }>()
let total = 0
profile.samples.forEach((id, index) => {
  if (!inPhase(id)) return
  const node = byId.get(id)
  if (!node) throw new Error(`unknown node ${id}`)
  const micros = profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0
  const kind = category(node.callFrame)
  total += micros
  byCategory.set(kind, (byCategory.get(kind) ?? 0) + micros)
  const module = node.callFrame.url.endsWith("dist/main.js") ? bundleModule(node.callFrame.lineNumber).split("/").slice(-2).join("/") : node.callFrame.url.split("/").slice(-2).join("/")
  const key = isFieldInitializer(node.callFrame) ? "(HostElement / HostText field initializers) [dist/host.js]" : `${node.callFrame.functionName || "(anonymous)"} [${module}:${node.callFrame.lineNumber + 1}]`
  const entry = byFunction.get(key) ?? { micros: 0, category: kind }
  entry.micros += micros
  byFunction.set(key, entry)
})

const percent = (value: number) => `${((value / total) * 100).toFixed(1)}%`
console.log(`samples under profilePhaseJsAndOps: ${(total / 1000).toFixed(1)} ms of self time`)
for (const [kind, micros] of [...byCategory].sort((a, b) => b[1] - a[1])) console.log(`  ${percent(micros).padStart(6)}  ${(micros / 1000).toFixed(1).padStart(8)} ms  ${kind}`)
console.log(`top ${top} functions by self time:`)
for (const [name, entry] of [...byFunction].sort((a, b) => b[1].micros - a[1].micros).slice(0, top)) {
  console.log(`  ${percent(entry.micros).padStart(6)}  ${(entry.micros / 1000).toFixed(1).padStart(8)} ms  ${name}  <${entry.category}>`)
}
