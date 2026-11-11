/**
 * `DOMRectReadOnly` and `DOMRect`: the rectangles a library builds (`DOMRect.fromRect`) and the
 * ones `getClientRects` gives. A negative `width` or `height` is a rect that extends left or up,
 * so `left` and `right` are the lesser and the greater of the two edges, as in the DOM.
 */

export interface DOMRectInit {
  x?: number
  y?: number
  width?: number
  height?: number
}

export class DOMRectReadOnly {
  readonly #x: number
  readonly #y: number
  readonly #width: number
  readonly #height: number

  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.#x = Number(x)
    this.#y = Number(y)
    this.#width = Number(width)
    this.#height = Number(height)
  }

  static fromRect(other: DOMRectInit = {}): DOMRectReadOnly {
    return new DOMRectReadOnly(other.x, other.y, other.width, other.height)
  }

  get x(): number {
    return this.#x
  }

  get y(): number {
    return this.#y
  }

  get width(): number {
    return this.#width
  }

  get height(): number {
    return this.#height
  }

  // Through the accessors, which a `DOMRect` overrides: its edges follow what is set.
  get left(): number {
    return Math.min(this.x, this.x + this.width)
  }

  get right(): number {
    return Math.max(this.x, this.x + this.width)
  }

  get top(): number {
    return Math.min(this.y, this.y + this.height)
  }

  get bottom(): number {
    return Math.max(this.y, this.y + this.height)
  }

  toJSON(): Record<"x" | "y" | "width" | "height" | "top" | "right" | "bottom" | "left", number> {
    return {
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      top: this.top,
      right: this.right,
      bottom: this.bottom,
      left: this.left,
    }
  }
}

/** A `DOMRectReadOnly` whose `x`, `y`, `width` and `height` can be set. */
export class DOMRect extends DOMRectReadOnly {
  #x: number
  #y: number
  #width: number
  #height: number

  constructor(x = 0, y = 0, width = 0, height = 0) {
    super(x, y, width, height)
    this.#x = Number(x)
    this.#y = Number(y)
    this.#width = Number(width)
    this.#height = Number(height)
  }

  static override fromRect(other: DOMRectInit = {}): DOMRect {
    return new DOMRect(other.x, other.y, other.width, other.height)
  }

  override get x(): number {
    return this.#x
  }

  set x(value: number) {
    this.#x = Number(value)
  }

  override get y(): number {
    return this.#y
  }

  set y(value: number) {
    this.#y = Number(value)
  }

  override get width(): number {
    return this.#width
  }

  set width(value: number) {
    this.#width = Number(value)
  }

  override get height(): number {
    return this.#height
  }

  set height(value: number) {
    this.#height = Number(value)
  }
}

/** What `getClientRects` returns: the rects, with the `item` method of a `DOMRectList`. */
export class DOMRectList extends Array<DOMRect> {
  item(index: number): DOMRect | null {
    return this[index] ?? null
  }
}
