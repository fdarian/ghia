#!/bin/sh
# JS heap bytes allocated per step, from JavaScriptCore's GC log: the heap size at the start of each collection minus the size the
# previous one left, summed between the markers of profile.tsx; divide by the steps (K, times the step kinds of the mode). The partial cycles
# at both ends are not counted, so use a large K. Native (Rust) allocations are not in it.
#   cd examples && GHIA_BENCH_MESSAGES=... FIXTURE=detail MODE=toggle K=1000 sh solid/mount-cost/alloc-per-step.sh
set -e
log=$(mktemp)
NODE_ENV=production YIELD=1 MARK=1 BUN_JSC_logGC=1 bun --bun run profile-mount-cost > "$log" 2>&1 || { cat "$log"; exit 1; }
awk '
  /=== measured start/ { on = 1; prev = -1; next }
  /=== measured end/ { on = 0 }
  on && match($0, /START M [0-9]+kb/) {
    size = substr($0, RSTART + 8, RLENGTH - 10) + 0
    if (prev >= 0) { kb += size - prev; cycles++ }
  }
  on && match($0, /=> [0-9]+kb, p=/) { prev = substr($0, RSTART + 3, RLENGTH - 8) + 0 }
  END { printf "%d collection intervals, %.1f MB allocated between them (heap size at a collection start minus the size the last one left)\n", cycles, kb / 1024 }
' "$log"
grep "M instr" "$log" | sed 's/^/  /'
