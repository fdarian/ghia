#!/bin/sh
# Builds the e2e's two native helpers next to the other e2e artifacts, not into the repository: the
# program that sends the quit Apple Event to a pid, and the library the app loads to close its own window.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out="$HOME/.cache/gpuix-quit-e2e"
mkdir -p "$out"
if [ ! -f "$out/quit_killer" ] || [ "$here/quit_killer.m" -nt "$out/quit_killer" ]; then
  clang -fobjc-arc -framework AppKit -o "$out/quit_killer" "$here/quit_killer.m"
fi
if [ ! -f "$out/libquit_helper.dylib" ] || [ "$here/quit_helper.m" -nt "$out/libquit_helper.dylib" ]; then
  clang -dynamiclib -fobjc-arc -framework AppKit -o "$out/libquit_helper.dylib" "$here/quit_helper.m"
fi
