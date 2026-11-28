#!/bin/sh
# Runs a command and reports every window it, or a process it spawned, puts on a display with alpha above zero.
# Exit status: 1 when it saw one (even if the command passed), else the command's own.
#
#   scripts/watch-windows/run.sh cargo test -p gpui_macos
#   scripts/watch-windows/run.sh sh -c 'cd packages/react && bun run test'
#
# The command is the root of the process tree that is watched, so a window of another app is not reported.
set -u
here=$(cd "$(dirname "$0")" && pwd)
bin="${TMPDIR:-/tmp}/ghia-watch-windows"
if [ ! -x "$bin" ] || [ "$here/watch.swift" -nt "$bin" ]; then
  swiftc -O "$here/watch.swift" -o "$bin" || exit 2
fi
log=$(mktemp)
"$@" &
command_pid=$!
"$bin" "$command_pid" > "$log" &
watch_pid=$!
wait "$command_pid"
status=$?
# The watcher leaves by itself once the command's pid is gone; its last poll can still be running.
wait "$watch_pid"
seen=$?
if [ "$seen" -ne 0 ]; then
  echo "watch-windows: the command showed windows:" >&2
  cat "$log" >&2
  rm -f "$log"
  exit 1
fi
rm -f "$log"
exit "$status"
