/**
 * What `DOMTokenList`, `HTMLCollection` and `NodeList` share: the DOM's indexed getter (`list[0]`,
 * `0 in list`, the own keys `"0"`..`"length - 1"`), which the classes cannot have as members because
 * the items change under them, and the HTML space characters their texts are split on.
 */

const SPACES = /[\t\n\f\r ]+/

/** The tokens of `text` split on HTML whitespace, with no empty one. */
export function splitOnSpaces(text: string): string[] {
  return text.split(SPACES).filter((token) => token !== "")
}

/** The index a property key stands for: a canonical array index, `undefined` for any other key. */
export function indexOfKey(key: string | symbol): number | undefined {
  if (typeof key !== "string") return undefined
  // Nearly every key is a method or a property name, so the pattern runs only for one that starts with a digit.
  const first = key.charCodeAt(0)
  if (first < 48 || first > 57 || !/^(0|[1-9][0-9]*)$/.test(key)) return undefined
  return Number(key)
}

export type IndexedSource = {
  length(): number
  at(index: number): unknown
}

/** Properties looked up by name where the list has no member of that name (`HTMLCollection`'s ids and names). */
export type NamedSource = {
  get(name: string): unknown
  has(name: string): boolean
}

/**
 * A view of `target` whose index keys read `source`. Indices are read only: assigning one is refused,
 * as the DOM's lists refuse it. A string key that is not an index and that `target` has no member
 * of (an own property, the prototype's, an inherited one) is looked up in `named` when it is given;
 * a symbol never is.
 */
export function indexedView<Target extends object>(target: Target, source: IndexedSource, named?: NamedSource): Target {
  const isNamed = (key: string | symbol): key is string => named !== undefined && typeof key === "string" && !Reflect.has(target, key)
  return new Proxy(target, {
    get(self, key) {
      const index = indexOfKey(key)
      if (index !== undefined) return source.at(index)
      if (isNamed(key)) return named?.get(key)
      return Reflect.get(self, key, self)
    },
    has(self, key) {
      const index = indexOfKey(key)
      if (index !== undefined) return index < source.length()
      if (isNamed(key)) return named?.has(key) === true
      return Reflect.has(self, key)
    },
    ownKeys(self) {
      const keys: Array<string | symbol> = Array.from({ length: source.length() }, (_unused, index) => String(index))
      return keys.concat(Reflect.ownKeys(self))
    },
    getOwnPropertyDescriptor(self, key) {
      const index = indexOfKey(key)
      if (index === undefined) return Reflect.getOwnPropertyDescriptor(self, key)
      const item = source.at(index)
      return item === undefined ? undefined : { value: item, writable: false, enumerable: true, configurable: true }
    },
    set(self, key, value) {
      return indexOfKey(key) === undefined && Reflect.set(self, key, value, self)
    },
  })
}
