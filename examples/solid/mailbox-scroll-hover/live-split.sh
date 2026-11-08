#!/usr/bin/env bash
# One bench app (a ghia-bench dist/Mailbox-*.app) launched the way the bench launches it (benchhelper launch: LaunchServices,
# activated, key window), then the hover split measured from outside: per-thread CPU time and instructions of
#   idle, scroll, hover        the bench's own phases, in the bench's order, in the same process
#   own:out, own:row, own:path (x2)  live-poster.ts moves: over the title band (no element, no crossing), inside row 0 (an element,
#                              no crossing) and the bench's hover path
# unsampled, and then an idle of 4 s, hover, own:out, own:row and own:path again, three times each, under `sample` (1 ms, main thread call
# graph; the idle sample is the baseline the report subtracts). The app is quit by pid.
#   examples/solid/mailbox-scroll-hover/live-split.sh <path to Mailbox-*.app> <label> <out dir>
# Takes the screen (the app is activated): run it under ~/.claude/notes/plans/ghia-bench-screen.sh. Needs ghia-bench's
# harness/bin/benchhelper (GHIA_BENCH_HELPER). Writes <out dir>/<label>.phases.txt and <label>.<phase>.sample<rep>.txt.
set -euo pipefail

app="$1"
label="$2"
out="$3"
helper="${GHIA_BENCH_HELPER:-$HOME/code/fdarian/ghia-bench/harness/bin/benchhelper}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"

pid="$("$helper" launch --app "$app" | jq -r .pid)"
trap 'kill -TERM "$pid" 2>/dev/null || true' EXIT
echo "$label pid $pid" | tee "$out/$label.phases.txt"
sleep 3.5
"$helper" window --pid "$pid" | tee -a "$out/$label.phases.txt"

bun "$here/live-phase.ts" "$pid" idle scroll hover own:out own:row own:path own:out own:row own:path >> "$out/$label.phases.txt"

for rep in 1 2 3; do
  for phase in idle hover own:out own:row own:path; do
    seconds=6
    [ "$phase" = idle ] && seconds=5
    sample "$pid" "$seconds" 1 -file "$out/$label.${phase/:/-}.sample$rep.txt" > /dev/null &
    sampler=$!
    sleep 0.3
    IDLE_SECONDS=4 bun "$here/live-phase.ts" "$pid" "$phase" >> "$out/$label.phases.txt"
    wait "$sampler"
  done
done

kill -TERM "$pid"
trap - EXIT
for _ in $(seq 1 40); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
if kill -0 "$pid" 2>/dev/null; then echo "$label: pid $pid did not quit" >&2; exit 1; fi
