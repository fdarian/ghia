#!/usr/bin/env bash
# One bench app (a ghia-bench dist/Mailbox-*.app) launched the way the bench launches it (benchhelper launch: LaunchServices,
# activated, key window), then the bench's own type and navigate phases (benchhelper phase, CGEventPostToPid to that pid, no capture)
# measured from outside, in the bench's order inside one process:
#   idle 10 s, scroll, hover                 warm-up, as a bench session has them before type
#   (type, navigate) x3, unsampled           per-thread CPU time and ri_instructions of each phase (live-phase.ts)
# and then idle 4 s, (type, navigate) three times under `sample` (1 ms, main thread call graph; the idle sample is the baseline the
# report subtracts). type = 16 characters + 16 backspaces (32 keystrokes, 150 ms apart); navigate = 30 ArrowDown (120 ms apart).
# type clears the search box, so every navigate starts on row 0. The app is quit by pid.
# FIRST=1 measures the bench's own situation instead: idle 10 s, scroll, hover, then the FIRST type and navigate of the session under
# `sample` (one repetition), then an idle sample. The unsampled repetitions above are warmer than the bench's (JavaScriptCore's JIT
# threads and the text caches settle over the first runs), so their instructions are lower than the bench's for Ghia and for GPUI.
#   examples/solid/mailbox-scroll-hover/live-split-keys.sh <path to Mailbox-*.app> <label> <out dir>
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

if [ -n "${FIRST:-}" ]; then
  bun "$here/live-phase.ts" "$pid" idle scroll hover >> "$out/$label.phases.txt"
  reps="1"
  phases="type navigate idle"
else
  bun "$here/live-phase.ts" "$pid" idle scroll hover type navigate type navigate type navigate >> "$out/$label.phases.txt"
  reps="1 2 3"
  phases="idle type navigate"
fi

for rep in $reps; do
  for phase in $phases; do
    seconds=8
    [ "$phase" = idle ] && seconds=5
    [ "$phase" = navigate ] && seconds=6
    sample "$pid" "$seconds" 1 -file "$out/$label.$phase.sample$rep.txt" > /dev/null &
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
