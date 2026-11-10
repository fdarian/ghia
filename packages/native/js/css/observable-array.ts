/**
 * A WebIDL `ObservableArray`: an array whose every change, by assignment of an index or `length` or
 * by a mutating method, is checked and reported once. `document.adoptedStyleSheets` is one.
 */

export interface ObservableArray<T> {
  /** The array the page holds: always this one object. */
  readonly array: T[]
  /** Replaces the contents, as assigning to the property does. Throws before changing anything when a value is not valid. */
  replace(values: Iterable<unknown>): void
}

const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"])

function indexOf(key: string | symbol): number | undefined {
  if (typeof key !== "string") return undefined
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && String(index) === key ? index : undefined
}

/** The values a mutating method puts into the array, which are the ones to check. */
function incoming(method: string, args: readonly unknown[]): readonly unknown[] {
  switch (method) {
    case "push":
    case "unshift":
      return args
    case "splice":
      return args.slice(2)
    case "fill":
      return args.slice(0, 1)
    default:
      return []
  }
}

function changed(before: readonly unknown[], after: readonly unknown[]): boolean {
  return before.length !== after.length || before.some((value, index) => value !== after[index])
}

/**
 * @param convert Returns the value to store for `value`, or throws a `TypeError`.
 * @param onChange Called after a change that left the contents different.
 */
export function observableArray<T>(convert: (value: unknown) => T, onChange: () => void): ObservableArray<T> {
  const target: T[] = []

  const mutate = (change: () => boolean): boolean => {
    const before = target.slice()
    const result = change()
    if (changed(before, target)) onChange()
    return result
  }

  const array: T[] = new Proxy(target, {
    get(_, key, receiver) {
      if (typeof key === "string" && MUTATORS.has(key)) {
        const method = Reflect.get(Array.prototype, key) as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          const values = incoming(key, args).map(convert)
          if (key === "push" || key === "unshift") args = values
          else if (key === "splice") args = [...args.slice(0, 2), ...values]
          else if (key === "fill") args = [values[0], ...args.slice(1)]
          let result: unknown
          mutate(() => {
            result = method.apply(target, args)
            return true
          })
          return result === target ? receiver : result
        }
      }
      return Reflect.get(target, key, target)
    },
    set(_, key, value) {
      if (key === "length") {
        return mutate(() => Reflect.set(target, key, value))
      }
      if (indexOf(key) === undefined) return Reflect.set(target, key, value, target)
      const converted = convert(value)
      return mutate(() => Reflect.set(target, key, converted, target))
    },
    defineProperty(_, key, descriptor) {
      if (indexOf(key) !== undefined && "value" in descriptor) {
        return mutate(() => Reflect.defineProperty(target, key, { ...descriptor, value: convert(descriptor.value) }))
      }
      return Reflect.defineProperty(target, key, descriptor)
    },
    deleteProperty(_, key) {
      const index = indexOf(key)
      if (index === undefined) return Reflect.deleteProperty(target, key)
      if (index >= target.length) return true
      // A hole would leave an entry that is not a sheet, so only the last one can go.
      if (index !== target.length - 1) return false
      return mutate(() => {
        target.length = index
        return true
      })
    },
  })

  return {
    array,
    replace(values) {
      const converted = [...values].map(convert)
      mutate(() => {
        target.splice(0, target.length, ...converted)
        return true
      })
    },
  }
}
