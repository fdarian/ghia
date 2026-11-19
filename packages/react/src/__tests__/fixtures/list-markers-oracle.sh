#!/bin/sh
# Regenerates list-markers-oracle.json (device scale 1) and list-markers-oracle-x2.json (scale 2) from
# list-markers-oracle.html and list-markers-cases.json with headless Chrome: per `li` of every case its box, the box of
# the first line of its text, its computed list-style and the device pixel box of the ink of its marker (see the page and
# list-markers-oracle.py for how a marker is measured). Chrome paints `disc`, `circle` and `square` as shapes and gives
# scripts no box for any marker, which is why the ink is what is recorded.
set -eu
cd "$(dirname "$0")"
CHROME=${CHROME:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
PAGE="file://$PWD/list-markers-oracle.html"
for scale in 1 2; do
  flags="--headless --force-device-scale-factor=$scale --allow-file-access-from-files --hide-scrollbars"
  "$CHROME" $flags --window-size=2240,800 --dump-dom "$PAGE" 2>/dev/null | grep -o 'data-oracle="[^"]*"' \
    | /usr/bin/python3 -I -c 'import html, re, sys; print(html.unescape(re.sub(r"^data-oracle=\"|\"$", "", sys.stdin.read().strip())))' > "$WORK/layout$scale.json"
  height=$(/usr/bin/python3 -I -c "import json; print(json.load(open('$WORK/layout$scale.json'))['height'] + 10)")
  "$CHROME" $flags --window-size=2240,$height "--screenshot=$WORK/shot$scale.png" "$PAGE" >/dev/null 2>&1
done
/usr/bin/python3 -I list-markers-oracle.py "$WORK/layout1.json" "$WORK/shot1.png" 1 list-markers-oracle.json
/usr/bin/python3 -I list-markers-oracle.py "$WORK/layout2.json" "$WORK/shot2.png" 2 list-markers-oracle-x2.json
