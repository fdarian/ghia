// The Settings dialog of Settings.tsx built as plain GPUI divs (packages/native/src/oracle/settings.rs), laid out in the oracle window:
// what the layout engine does for the same tree with none of Ghia's host layer. Prints the layout counters of the first frame (a mount)
// and of a second frame that rebuilds the tree on warm caches.
//
//   cd examples && bun solid/mount-cost/raw-layout.ts
import { RowOracle } from "../../../packages/native/index.js"

const names = ["nodesCreated", "measures", "nodesLaidOut", "nodesSized", "passes"]

function delta(after: number[], before: number[]) {
  return Object.fromEntries(names.map((name, index) => [name, (after[index] ?? 0) - (before[index] ?? 0)]))
}

for (const kind of ["settings", "settingsWrapped"]) {
  for (const ghiaWindow of [false, true]) {
    const oracle = new RowOracle({ width: 1280, height: 800, domHitTesting: ghiaWindow, maxDrawPasses: ghiaWindow ? 4 : 1 })
    oracle.setInlineDraws(false)
    oracle.setRowKind(kind)
    const before = oracle.getLayoutCounters()
    oracle.drawWholeFrame()
    const first = oracle.getLayoutCounters()
    oracle.drawWholeFrame()
    const second = oracle.getLayoutCounters()
    console.log(`${kind} ghiaWindowOptions=${ghiaWindow} first frame`, JSON.stringify(delta(first, before)))
    console.log(`${kind} ghiaWindowOptions=${ghiaWindow} rebuild frame`, JSON.stringify(delta(second, first)))
    oracle.dispose()
  }
}
