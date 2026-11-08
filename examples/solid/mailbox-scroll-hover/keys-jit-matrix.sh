#!/bin/sh
# Runs profile-keys.tsx's bundle (`ghia build solid/mailbox-scroll-hover/profile-keys.tsx --no-compile` in examples/, then dist/main.js) for the bench's
# type and navigate phases under JavaScriptCore / Bun environment switches, one process each, paced in real time, and prints per run of the key sequence
# the instructions per key and the JIT / GC helper threads' CPU. Needs GHIA_BENCH_MESSAGES. HEAVY="sh /path/to/lock-wrapper.sh" puts a command in front of each run (a shared-machine lock).
#   keys-jit-matrix.sh <bundle.js> <out dir> [loops=8]
# The configs: default, no FTL, no DFG (Baseline only), Bun's GC timer off, GC timer off and no FTL. `BUN_JSC_useJIT=0` crashes this bundle (bun:ffi).
set -eu
bundle=$1
out=$2
loops=${3:-8}
mkdir -p "$out"
export NODE_ENV=production PACE=1 LOOPS=$loops THREADS=1
for phase in type navigate; do
  for config in default:X=1 noFTL:BUN_JSC_useFTLJIT=0 noDFG:BUN_JSC_useDFGJIT=0 gcTimerOff:BUN_GC_TIMER_DISABLE=1 gcTimerOff_noFTL:BUN_GC_TIMER_DISABLE=1,BUN_JSC_useFTLJIT=0; do
    name=${config%%:*}
    vars=$(echo "${config#*:}" | tr ',' ' ')
    env $vars PHASE=$phase ${HEAVY:-} bun "$bundle" > "$out/$phase-$name.txt" 2>&1
    echo "== $phase $name"
    grep -E "^(type|navigate):|mean M instr|^    (main|JIT|Heap|mi-sc)" "$out/$phase-$name.txt"
  done
done
