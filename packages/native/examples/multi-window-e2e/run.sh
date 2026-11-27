#!/bin/sh
# One command: starts one fresh app process per case, each with two real windows on one GPUI App, and
# checks that a window closed alone leaves the other running and drawing, that the app ends with the last
# window, and that `onTerminated` runs once. Exit status: 0 every case passed, 1 a case failed, 2 the e2e
# could not run, 3 the machine gave the app no windows (the screen is locked or asleep, no window server
# session): it prints "not checkable: <the condition>". Needs a release addon with test-support (`bun run
# build` in packages/native) and the React package built (`bun run build` in packages/react).
#
# `E2E_ONLY=close-second,close-first` runs only those cases: close-second, close-first, close-button, close-all, quit.
set -e
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/../quit-e2e/build-helper.sh"
cd "$here"
exec bun runner.ts "$@"
