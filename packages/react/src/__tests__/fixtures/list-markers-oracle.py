"""List marker ink, from headless Chrome screenshots, stdlib only.
usage: python3 -I list-markers-oracle.py <layout.json> <shot.png> <scale> <out.json>
For every `li` of the page's answer (list-markers-oracle.html) the ink box of its marker: the chromatic pixels of the
item's own colour, in the rows of the first line of its text and in the columns from 90 CSS px before its box to its
left edge (`outside`) or to its text (`inside`). A pixel is ink when it is more than 64 off white in some channel and
its colour is near the item's by direction (the text is black and the other items' markers are the other hue).
The box is [left, top, right, bottom] in device pixels of the screenshot, relative to the band, or null for no ink;
the area is the number of ink pixels, which tells one digit from another where their boxes are the same."""
import json
import re
import struct
import sys
import zlib

THRESHOLD = 64


def read_png(path):
    data = open(path, 'rb').read()
    pos = 8
    idat = []
    ihdr = None
    while pos < len(data):
        length, = struct.unpack('>I', data[pos:pos + 4])
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if kind == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat.append(body)
    width, height, depth, ctype, _, _, interlace = ihdr
    channels = {2: 3, 6: 4}[ctype]
    assert depth == 8 and interlace == 0
    raw = zlib.decompress(b''.join(idat))
    stride = width * channels
    rows = []
    prev = bytearray(stride)
    for y in range(height):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else (b if pb <= pc else c))) & 255
        rows.append(line)
        prev = line
    return width, height, channels, rows


def ink_box(rows, channels, x0, x1, y0, y1, color):
    """The device pixel box of the ink of `color` in the region and how many pixels it has, or (None, 0)."""
    want = [255 - c for c in color]
    norm = sum(w * w for w in want) ** 0.5
    box = None
    area = 0
    for y in range(y0, y1):
        line = rows[y]
        for x in range(x0, x1):
            got = [255 - line[x * channels + k] for k in range(3)]
            if max(got) <= THRESHOLD:
                continue
            length = sum(g * g for g in got) ** 0.5
            if sum(g * w for g, w in zip(got, want)) / (length * norm) < 0.9:
                continue
            area += 1
            box = [x, y, x + 1, y + 1] if box is None else [min(box[0], x), min(box[1], y), max(box[2], x + 1), max(box[3], y + 1)]
    return box, area


def main():
    layout = json.load(open(sys.argv[1]))
    shot, scale, out = sys.argv[2], int(sys.argv[3]), sys.argv[4]
    width, height, channels, rows = read_png(shot)
    assert width >= layout['width'] * scale, (width, layout['width'])
    result = {'scale': scale, 'cases': []}
    for case in layout['cases']:
        origin_x, origin_y = round(case['left'] * scale), round(case['top'] * scale)
        items = []
        for item in case['items']:
            color = [int(v) for v in re.findall(r'\d+', item['color'])[:3]]
            box, text = item['box'], item['text']
            x0 = round((case['left'] + max(0, box[0] - 90)) * scale)
            x1 = round((case['left'] + (text[0] if item['position'] == 'inside' else box[0])) * scale)
            y0 = round((case['top'] + text[1]) * scale)
            y1 = round((case['top'] + text[1] + text[3]) * scale)
            ink, area = ink_box(rows, channels, x0, x1, y0, y1, color)
            if ink is not None:
                ink = [ink[0] - origin_x, ink[1] - origin_y, ink[2] - origin_x, ink[3] - origin_y]
            items.append({**item, 'ink': ink, 'area': area})
        result['cases'].append({'name': case['name'], 'items': items})
    json.dump(result, open(out, 'w'), separators=(',', ':'))


main()
