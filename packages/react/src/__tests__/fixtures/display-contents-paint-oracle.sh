#!/bin/sh
# Regenerates display-contents-paint-oracle.json from display-contents-paint-oracle.html with headless Chrome: the colour
# at the middle of each square, at device scale 1.
set -e
cd "$(dirname "$0")"
CHROME=${CHROME:-$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
"$CHROME" --headless --window-size=1280,200 --force-device-scale-factor=1 --hide-scrollbars \
  --screenshot="$WORK/page.png" "file://$PWD/display-contents-paint-oracle.html" >/dev/null 2>&1
python3 -I - "$WORK/page.png" display-contents-paint-oracle.json <<'PY'
import json, struct, sys, zlib

data = open(sys.argv[1], "rb").read()
pos, idat, width, height, depth, kind = 8, b"", 0, 0, 0, 0
while pos < len(data):
    length, tag = struct.unpack(">I4s", data[pos:pos + 8])
    body = data[pos + 8:pos + 8 + length]
    if tag == b"IHDR":
        width, height, depth, kind = struct.unpack(">IIBB", body[:10])
    elif tag == b"IDAT":
        idat += body
    pos += 12 + length
assert depth == 8 and kind in (2, 6), (depth, kind)
channels = 4 if kind == 6 else 3
raw, stride = zlib.decompress(idat), width * channels
rows, previous = [], bytearray(stride)
for y in range(height):
    base = y * (stride + 1)
    filter_type, line = raw[base], bytearray(raw[base + 1:base + 1 + stride])
    for x in range(stride):
        left = line[x - channels] if x >= channels else 0
        up, up_left = previous[x], (previous[x - channels] if x >= channels else 0)
        if filter_type == 1: line[x] = (line[x] + left) & 255
        elif filter_type == 2: line[x] = (line[x] + up) & 255
        elif filter_type == 3: line[x] = (line[x] + (left + up) // 2) & 255
        elif filter_type == 4:
            p = left + up - up_left
            pa, pb, pc = abs(p - left), abs(p - up), abs(p - up_left)
            line[x] = (line[x] + (left if pa <= pb and pa <= pc else up if pb <= pc else up_left)) & 255
    rows.append(line)
    previous = line

names = ["opacity 0 on contents", "visibility hidden on contents", "visible child of hidden contents", "opacity 0 on a block"]
pixel = lambda x, y: [rows[y][x * channels + c] for c in range(3)]
json.dump({name: pixel(100 * i + 20, 20) for i, name in enumerate(names)}, open(sys.argv[2], "w"), indent=2)
PY
