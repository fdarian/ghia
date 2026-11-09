import type { MutationValue } from "./mutations.js"

const NO_STYLE = "{}"

/** What `entries` holds: the last write, not yet taken, or never (an object in it). */
type EntriesState = "known" | "stale" | "notPrimitive"

/**
 * What a host last wrote for one element, so that writing it again queues nothing: the DOM
 * does nothing for `el.title = el.title`, and every op costs JSON, a parse and a compare in
 * native.
 *
 * A write is remembered as the JSON that native would be sent, so two writes are equal exactly
 * when native would be sent the same thing (`undefined` keys absent, key order kept, since of a
 * shorthand and a longhand the later one wins), and a style object changed in place and passed
 * again is not taken for the one written before.
 *
 * Only the host's own writes are known here. A value native can change by itself (a text
 * control's `value`) is not restored by writing it again, as in React DOM's `commitUpdate`.
 */
export class SentWrites {
  private style = NO_STYLE
  /**
   * The style last written as alternating keys and values, `undefined` values left out, so that
   * an equal style is recognised without stringifying it. It is taken only when a write turns out
   * equal by its JSON (an element written once never pays for it), and only when every value is a
   * primitive: an object or an array is left to `JSON.stringify`.
   */
  private entries: unknown[] = []
  private entryLength = 0
  private entriesState: EntriesState = "known"
  private props: Map<string, string> | undefined

  /** Call when the native element is created: it holds no style and no prop. */
  reset(): void {
    this.style = NO_STYLE
    this.entryLength = 0
    this.entriesState = "known"
    this.props = undefined
  }

  /** The JSON of the style written last: what `writesStyle` compared, and what native is sent. */
  get styleJson(): string {
    return this.style
  }

  /** Whether `style` is not the style written last; remembers it when it is not. */
  writesStyle(style: object): boolean {
    if (this.matchesEntries(style)) return false
    const json = JSON.stringify(style)
    if (json === this.style) {
      if (this.entriesState === "stale") this.rememberEntries(style)
      return false
    }
    this.style = json
    this.entriesState = "stale"
    return true
  }

  /**
   * Whether `style` has the keys of the last write in the same order, each holding the same
   * primitive. `NaN` never matches itself, which sends the write to the comparison of JSON.
   */
  private matchesEntries(style: object): boolean {
    if (this.entriesState !== "known") return false
    const entries = this.entries
    let at = 0
    for (const key in style) {
      const value = (style as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (at === this.entryLength || entries[at] !== key || entries[at + 1] !== value) return false
      at += 2
    }
    return at === this.entryLength
  }

  /** `style` is equal to the last write, by its JSON. */
  private rememberEntries(style: object): void {
    let at = 0
    for (const key in style) {
      const value = (style as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        this.entriesState = "notPrimitive"
        return
      }
      this.entries[at] = key
      this.entries[at + 1] = value
      at += 2
    }
    this.entryLength = at
    this.entriesState = "known"
  }

  /**
   * Whether `value` is not the value written last for `name`; remembers it when it is not. A
   * prop never written is always written, even as `null`.
   */
  writesProp(name: string, value: MutationValue): boolean {
    this.props ??= new Map()
    const json = JSON.stringify(value)
    if (this.props.get(name) === json) return false
    this.props.set(name, json)
    return true
  }
}
