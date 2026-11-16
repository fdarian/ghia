#!/bin/sh
# Runs the mount-cost harness runs of the taffy layout-cache spike, one output file each under $1.
# Usage: examples/solid/mount-cost/zgui-spike-runs.sh <output-dir>
# Wrap each call of this script in ~/.claude/notes/plans/gpuix-heavy.sh when other leads share the machine.
set -eu
out=${1:?usage: zgui-spike-runs.sh <output-dir>}
messages=${GHIA_BENCH_MESSAGES:-/Users/farreldarian/code/fdarian/ghia-bench/data/messages.json}
examples=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$out"
cd "$examples"

run() {
  name=$1
  shift
  echo "== $name"
  env NODE_ENV=production JSON=1 COUNTERS=1 "$@" bun --bun run profile-mount-cost >"$out/$name.txt" 2>&1
}

run settings-toggle FIXTURE=settings MODE=toggle
run settings-scroll FIXTURE=settings MODE=scroll
run detail-swap FIXTURE=detail MODE=swap GHIA_BENCH_MESSAGES="$messages"
run detail-toggle FIXTURE=detail MODE=toggle GHIA_BENCH_MESSAGES="$messages"
echo "== raw-layout"
NODE_ENV=production bun solid/mount-cost/raw-layout.ts >"$out/raw-layout.txt" 2>&1
