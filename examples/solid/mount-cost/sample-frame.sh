#!/bin/sh
# A native sampling profile (macOS `sample`, 1 ms, every thread) of the bundle of profile.tsx while it loops, for sample-report.py.
# Needs the bundle: `NODE_ENV=production bun --bun run ghia build solid/mount-cost/profile.tsx --no-compile` in examples (dist/main.js).
# Env as profile.tsx (use a K that outlasts SECONDS_SAMPLED: the run is killed after the sample); INSTRUMENT is 0 here.
#   cd examples && FIXTURE=settings MODE=toggle K=100000 sh solid/mount-cost/sample-frame.sh /tmp/ghia-templates/mc/sample-settings.txt
# DELAY (default 8) seconds go to start-up and WARMUP before sampling, SECONDS_SAMPLED (default 15) is the length of the sample.
set -e
out=$1
[ -n "$out" ] || { echo "usage: sample-frame.sh <sample output file>"; exit 1; }
cd "$(dirname "$0")/../.."
NODE_ENV=production INSTRUMENT=0 bun dist/main.js > "$out.run.txt" 2>&1 &
pid=$!
sleep "${DELAY:-8}"
kill -0 "$pid" || { cat "$out.run.txt"; exit 1; }
sample "$pid" "${SECONDS_SAMPLED:-15}" 1 -file "$out" > /dev/null
kill "$pid"
wait "$pid" 2>/dev/null || true
