/** A keyframe of the array form: `offset`, `easing`, `composite` and the properties, which are strings. */
export type KeyframeObject = Record<string, unknown>

/**
 * What `Element.animate()` takes: an array of keyframes, one object with an array of values for
 * each property, or nothing for an effect with no keyframes.
 */
export type KeyframesInput = readonly KeyframeObject[] | KeyframeObject | null | undefined

/** A keyframe as native takes it: every offset set, each property a string. */
type NativeKeyframe = Record<string, string | number>

/** What native does not read as a property of a keyframe. */
const KEYFRAME_MEMBERS = new Set(["offset", "easing", "composite"])

const ANIMATE = "Failed to execute 'animate' on 'Element'"

function typeError(message: string): TypeError {
  return new TypeError(`${ANIMATE}: ${message}`)
}

function isIterable(value: object): value is Iterable<unknown> {
  return typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
}

function offsetOf(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const offset = Number(value)
  if (!Number.isFinite(offset)) throw typeError("keyframe offsets must be finite numbers")
  return offset
}

/** The properties a keyframe object sets, as the strings the browser reads. */
function propertiesOf(source: KeyframeObject): [string, string][] {
  const properties: [string, string][] = []
  for (const name of Object.keys(source)) {
    if (KEYFRAME_MEMBERS.has(name)) continue
    const value = source[name]
    // `cssFloat` and `cssOffset` name `float` and `offset`, neither of which is animated here.
    if (value === undefined || name === "cssFloat" || name === "cssOffset") continue
    properties.push([name, String(value)])
  }
  return properties
}

interface Parsed {
  offset: number | null
  easing: string
  properties: [string, string][]
}

function fromList(list: readonly unknown[]): Parsed[] {
  return list.map((item) => {
    if (typeof item !== "object" || item === null) throw typeError("keyframes must be objects")
    const source = item as KeyframeObject
    return {
      offset: offsetOf(source.offset),
      easing: source.easing === undefined ? "linear" : String(source.easing),
      properties: propertiesOf(source),
    }
  })
}

/** A member of the property-indexed form, which is one value or a list of them. */
function listOf(value: unknown): unknown[] {
  if (value === undefined) return []
  if (typeof value === "object" && value !== null && isIterable(value)) return [...value]
  return [value]
}

function fromProperties(source: KeyframeObject): Parsed[] {
  const offsets = listOf(source.offset)
  const easings = listOf(source.easing).map(String)
  // A property with n values has a keyframe at i / (n - 1) for each, and the only value of one is the end.
  const byOffset = new Map<number, [string, string][]>()
  for (const name of Object.keys(source)) {
    if (KEYFRAME_MEMBERS.has(name) || name === "cssFloat" || name === "cssOffset") continue
    const values = listOf(source[name]).filter((value) => value !== undefined)
    values.forEach((value, index) => {
      const offset = values.length === 1 ? 1 : index / (values.length - 1)
      const properties = byOffset.get(offset) ?? []
      properties.push([name, String(value)])
      byOffset.set(offset, properties)
    })
  }
  const ordered = [...byOffset.entries()].sort(([first], [second]) => first - second)
  return ordered.map(([offset, properties], index) => ({
    // An offset given for the keyframe replaces the one the number of values made.
    offset: offsets.length > index ? offsetOf(offsets[index]) ?? offset : offset,
    easing: easings.length > 0 ? easings[index % easings.length] : "linear",
    properties,
  }))
}

/** The offsets the array form leaves out, spread between the ones given (Web Animations, "process a keyframes argument"). */
function distribute(frames: Parsed[]): number[] {
  const offsets = frames.map((frame) => frame.offset)
  const last = offsets.length - 1
  if (last >= 0 && offsets[last] === null) offsets[last] = 1
  if (last > 0 && offsets[0] === null) offsets[0] = 0
  let previous = 0
  for (let index = 0; index <= last; index++) {
    const offset = offsets[index]
    if (offset === null) continue
    if (offset < 0 || offset > 1) throw typeError("keyframe offsets must be between 0 and 1")
    if (index > 0 && offset < (offsets[previous] as number)) {
      throw typeError("keyframe offsets must be in ascending order")
    }
    const from = offsets[previous] as number
    const step = (offset - from) / (index - previous)
    for (let between = previous + 1; between < index; between++) {
      offsets[between] = from + step * (between - previous)
    }
    previous = index
  }
  return offsets as number[]
}

/**
 * The JSON native takes for the keyframes of `Element.animate()`: an array of `{ offset, easing,
 * <property>: value }` in ascending offset order, every offset set and every value a string. A
 * property name is passed on as written and native leaves out what it does not animate, as the
 * browser leaves out what it cannot read. `composite` is not carried: only `replace` is built.
 */
export function normalizeKeyframes(input: KeyframesInput): string {
  if (input === null || input === undefined) return "[]"
  if (typeof input !== "object") throw typeError("keyframes must be an array or an object")
  const frames = isIterable(input) ? fromList([...input]) : fromProperties(input as KeyframeObject)
  const offsets = distribute(frames)
  const native: NativeKeyframe[] = frames.map((frame, index) => {
    const keyframe: NativeKeyframe = { offset: offsets[index], easing: frame.easing }
    for (const [name, value] of frame.properties) keyframe[name] = value
    return keyframe
  })
  return JSON.stringify(native)
}
