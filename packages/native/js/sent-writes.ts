import type { MutationValue } from "./mutations.js"

const NO_STYLE = "{}"

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
  private props: Map<string, string> | undefined
  private attributes: Map<string, string> | undefined

  /** Call when the native element is created: it holds no style and no prop. */
  reset(): void {
    this.style = NO_STYLE
    this.props = undefined
    this.attributes = undefined
  }

  /** The JSON of the style written last: what `writesStyle` compared, and what native is sent. */
  get styleJson(): string {
    return this.style
  }

  /** Whether `style` is not the style written last; remembers it when it is not. */
  writesStyle(style: object): boolean {
    const json = JSON.stringify(style)
    if (json === this.style) return false
    this.style = json
    return true
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

  /** Records the attributes native holds for the element, which the host did not write through `writesAttribute`. It owns `attributes`. */
  rememberAttributes(attributes: Map<string, string>): void {
    this.attributes = attributes.size > 0 ? attributes : undefined
  }

  /**
   * Whether `value` is not what the attribute `name` holds in native; remembers it when it is
   * not. An attribute never written holds nothing, so removing it writes nothing.
   */
  writesAttribute(name: string, value: string | null): boolean {
    if (value === null) return this.attributes?.delete(name) ?? false
    this.attributes ??= new Map()
    if (this.attributes.get(name) === value) return false
    this.attributes.set(name, value)
    return true
  }
}
