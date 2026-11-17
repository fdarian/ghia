/**
 * Where a caret may stop in a text: the edges of grapheme clusters and of words, from
 * `Intl.Segmenter` (code points when the runtime has none).
 */

export type MovementGranularity = "character" | "word"

const segmenters: Partial<Record<MovementGranularity, Intl.Segmenter>> = {}

function segmenter(granularity: MovementGranularity): Intl.Segmenter | undefined {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return undefined
  const existing = segmenters[granularity]
  if (existing !== undefined) return existing
  const created = new Intl.Segmenter(undefined, { granularity: granularity === "word" ? "word" : "grapheme" })
  segmenters[granularity] = created
  return created
}

/** Whether `text` is exactly one grapheme cluster: what a typed key is. */
export function isSingleGrapheme(text: string): boolean {
  if (text === "") return false
  const segments = segmenter("character")
  if (segments === undefined) return [...text].length === 1
  const pieces = segments.segment(text)[Symbol.iterator]()
  pieces.next()
  return pieces.next().done === true
}

/** Where a caret may stop going `forward` or backward in `text`, ascending. */
function stopsOf(text: string, granularity: MovementGranularity, forward: boolean): number[] {
  const stops = [0, text.length]
  const segments = segmenter(granularity)
  if (segments !== undefined) {
    for (const piece of segments.segment(text)) {
      if (granularity === "word") {
        if (piece.isWordLike) stops.push(forward ? piece.index + piece.segment.length : piece.index)
      } else {
        stops.push(piece.index)
      }
    }
  } else if (granularity === "word") {
    for (const match of text.matchAll(/[\p{L}\p{N}_]+/gu)) stops.push(forward ? match.index + match[0].length : match.index)
  } else {
    let index = 0
    for (const codePoint of text) {
      stops.push(index)
      index += codePoint.length
    }
  }
  return stops.sort((a, b) => a - b)
}

/**
 * The next place a caret may stop after `from` going `forward` (or before it, backward) in `text`,
 * or `undefined` when `from` is already at that end. Both ends of the text are always stops.
 */
export function nextStop(text: string, from: number, forward: boolean, granularity: MovementGranularity): number | undefined {
  if (forward ? from >= text.length : from <= 0) return undefined
  const segments = segmenter(granularity)
  if (granularity === "character" && segments !== undefined) {
    // One cluster around the caret, not a segmentation of the whole text.
    const piece = segments.segment(text).containing(forward ? from : from - 1)
    if (piece === undefined) throw new Error(`Offset ${from} is outside the text of length ${text.length}`)
    return forward ? piece.index + piece.segment.length : piece.index
  }
  const stops = stopsOf(text, granularity, forward)
  return forward ? stops.find((stop) => stop > from) : stops.filter((stop) => stop < from).pop()
}
