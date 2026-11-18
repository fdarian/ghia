import fs from 'node:fs'
import zlib from 'node:zlib'

/** A decoded screenshot (8-bit RGBA, not interlaced, which is what the test renderer writes). */
export interface Screenshot {
  width: number
  height: number
  at(x: number, y: number): [number, number, number, number]
}

export function readScreenshot(file: string): Screenshot {
  const png = fs.readFileSync(file)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  if (png[24] !== 8 || png[25] !== 6 || png[28] !== 0) throw new Error('a screenshot is 8-bit RGBA and not interlaced')
  const chunks: Buffer[] = []
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at)
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks))
  const stride = width * 4
  const data = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    for (let x = 0; x < stride; x++) {
      const byte = raw[y * (stride + 1) + 1 + x]!
      const left = x >= 4 ? data[y * stride + x - 4]! : 0
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0
      const upLeft = x >= 4 && y > 0 ? data[(y - 1) * stride + x - 4]! : 0
      const paeth = (): number => {
        const estimate = left + up - upLeft
        const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)]
        return distances[0]! <= distances[1]! && distances[0]! <= distances[2]! ? left : distances[1]! <= distances[2]! ? up : upLeft
      }
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth()
      data[y * stride + x] = (byte + predicted) & 255
    }
  }
  return { width, height, at: (x, y) => [data[y * stride + x * 4]!, data[y * stride + x * 4 + 1]!, data[y * stride + x * 4 + 2]!, data[y * stride + x * 4 + 3]!] }
}

/**
 * The pixels of the strip left of a list item's box that differ from the page behind it: where its marker is painted
 * (an outside marker ends at the box's edge and is never wider than a few ems). `box` is in logical pixels.
 */
export function markerInk(shot: Screenshot, scale: number, box: { x: number; y: number; height: number }, strip = 40): number {
  const x0 = Math.max(0, Math.round((box.x - strip) * scale))
  const x1 = Math.round(box.x * scale)
  const y0 = Math.round(box.y * scale)
  const y1 = Math.min(shot.height, Math.round((box.y + Math.min(box.height, 24)) * scale))
  const background = shot.at(x0, y0)
  let ink = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const pixel = shot.at(x, y)
      if ([0, 1, 2].some((channel) => Math.abs(pixel[channel]! - background[channel]!) > 64)) ink++
    }
  }
  return ink
}

/** The strip as a string, to tell one number from another. */
export function markerPixels(shot: Screenshot, scale: number, box: { x: number; y: number; height: number }, strip = 40): string {
  const x0 = Math.max(0, Math.round((box.x - strip) * scale))
  const x1 = Math.round(box.x * scale)
  const y0 = Math.round(box.y * scale)
  const y1 = Math.min(shot.height, Math.round((box.y + Math.min(box.height, 24)) * scale))
  const rows: string[] = []
  for (let y = y0; y < y1; y++) {
    let row = ''
    for (let x = x0; x < x1; x++) row += shot.at(x, y)[0]! < 128 ? '#' : '.'
    rows.push(row)
  }
  return rows.join('\n')
}
