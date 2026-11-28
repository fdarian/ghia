#!/bin/sh
# Runs a command and reports every window it, or a process it spawned, puts on a display with alpha above zero.
# Exit status: 1 when it saw one (even if the command passed), 2 when the watcher failed to build or crashed,
# else the command's own.
#
#   scripts/watch-windows/run.sh cargo test -p gpui_macos
#   scripts/watch-windows/run.sh sh -c 'cd packages/react && bun run test'
#
# The command is the root of the process tree that is watched, so a window of another app is not reported.
set -u
if [ "$#" -eq 0 ]; then
  echo "usage: run.sh <command> [args...]" >&2
  exit 2
fi
here=$(cd "$(dirname "$0")" && pwd)
# Keyed by this checkout's path and the source, so two worktrees never swap each other's binary.
key=$({ echo "$here"; cat "$here/watch.swift"; } | shasum | cut -c1-16)
bin="${TMPDIR:-/tmp}/ghia-watch-windows-$key"
if [ ! -x "$bin" ]; then
  swiftc -O "$here/watch.swift" -o "$bin.$$" && mv "$bin.$$" "$bin" || exit 2
fi
log=$(mktemp)

# A job started with & ignores SIGINT in a non-interactive shell, and the ignore is inherited through exec
# (`trap - INT` in the job does not undo it). Job control gives the job SIGINT back and its own process group,
# so a Ctrl-C reaches only this script, which forwards the signal to the whole group, as a terminal would.
set -m
"$@" &
command_pid=$!
forward() {
  if [ "$command_pid" -gt 1 ]; then
    kill -s "$1" -- "-$command_pid" 2>/dev/null
  fi
}
trap 'forward INT' INT
trap 'forward TERM' TERM

"$bin" "$command_pid" > "$log" &
watch_pid=$!

# A trapped signal ends `wait` early with a status above 128 while the command may still be running.
while :; do
  wait "$command_pid"
  status=$?
  kill -0 "$command_pid" 2>/dev/null || break
done
# The watcher leaves by itself once the command's pid is gone; its last poll can still be running.
wait "$watch_pid"
seen=$?
case "$seen" in
  0) ;;
  1)
    echo "watch-windows: the command showed windows:" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 1
    ;;
  *)
    echo "watch-windows: the watcher failed (exit $seen), so the run is not verified:" >&2
    cat "$log" >&2
    rm -f "$log"
    exit 2
    ;;
esac
rm -f "$log"
exit "$status"
