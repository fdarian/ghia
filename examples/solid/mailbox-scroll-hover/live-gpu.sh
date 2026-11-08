#!/usr/bin/env bash
# The GPU time of each frame the bench's Mailbox presents in a live window, by phase (idle 10 s, scroll, hover in one process), beside the
# phase's CPU time: GPUI_GPU_TIMES logs every presented frame's kind and GPU busy time, live-phase.ts's PHASE_LOG the phases on the same
# clock, gpu-times-report.py joins them. Needs ghia-bench's data/messages.json (GHIA_BENCH_MESSAGES) and harness/bin/benchhelper.
#   examples/solid/mailbox-scroll-hover/live-gpu.sh <label> <out dir> [KEY=VALUE ...]
# `GPUIX_PARTIAL_REDRAW=1` as an extra argument measures a window that draws only what a frame changed. The window is not made key
# and the events go to its pid only; it takes the screen lock like any live run. Quits the app by pid.
set -uo pipefail
label="$1"
out="$2"
shift 2
here="$(cd "$(dirname "$0")" && pwd)"
examples="$(cd "$here/../.." && pwd)"
messages="${GHIA_BENCH_MESSAGES:-$HOME/code/fdarian/ghia-bench/data/messages.json}"
mkdir -p "$out"
rm -f "$out/$label.gpu" "$out/$label.phases" "$out/$label.out"

cd "$examples"
env NODE_ENV=production GHIA_BENCH_MESSAGES="$messages" GPUIX_BACKGROUND=1 GPUI_GPU_TIMES="$out/$label.gpu" "$@" \
  bun --bun run mailbox-live > "$out/$label.app.log" 2>&1 &
pid=""
for _ in $(seq 1 60); do
  pid=$(pgrep -f "$examples/node_modules.*dist/cli.js dev solid/mailbox-scroll-hover/live.tsx" | head -1)
  [ -n "$pid" ] && [ -s "$out/$label.gpu" ] && break
  sleep 1
done
echo "$label pid $pid" | tee "$out/$label.out"
sleep 4
cd "$here"
PHASE_LOG="$out/$label.phases" IDLE_SECONDS=10 sh "$HOME/.claude/notes/plans/ghia-bench-screen.sh" bun live-phase.ts "$pid" idle scroll hover >> "$out/$label.out" 2>&1
kill -TERM "$pid"
for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
kill -0 "$pid" 2>/dev/null && echo "pid $pid did not quit"
python3 "$here/gpu-times-report.py" "$out/$label.gpu" "$out/$label.phases" | tee "$out/$label.report"
