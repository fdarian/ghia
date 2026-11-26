#!/bin/sh
# One command: builds the helpers, starts one fresh app process per quit path and checks that each ends
# when asked to quit. Exit status: 0 every case passed, 1 a case failed, 2 the e2e could not run, 3 the
# machine gave no window to ask the app to quit from (the screen is locked or asleep, no window server
# session): it prints "not checkable: <the condition>". Needs a release addon with test-support (`bun run
# build` in packages/native) and the React package built (`bun run build` in packages/react).
#
# `E2E_ONLY=apple-event,last-window-close` runs only those cases: apple-event, apple-event-server,
# quit-action and last-window-close.
set -e
here=$(cd "$(dirname "$0")" && pwd)
sh "$here/build-helper.sh"
cd "$here"
exec bun runner.ts "$@"
