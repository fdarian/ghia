#!/bin/sh
# Regenerates computed-style-oracle.json from computed-style-oracle.html with headless Chrome.
set -e
cd "$(dirname "$0")"
CHROME=${CHROME:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell}
PAGE="file://$PWD/computed-style-oracle.html"
"$CHROME" --headless --window-size=1280,800 --virtual-time-budget=3000 --force-device-scale-factor=1 --dump-dom "$PAGE" 2>/dev/null \
  | grep -o 'data-oracle="[^"]*"' | sed 's/^data-oracle="//; s/"$//; s/&quot;/"/g; s/&amp;/\&/g; s/&lt;/</g; s/&gt;/>/g' > computed-style-oracle.json
