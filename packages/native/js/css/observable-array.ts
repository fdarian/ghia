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

/** The arguments of a mutating method with every value it would store converted, `fill`'s missing value included. */
function convertedArgs<T>(method: string, args: readonly unknown[], convert: (value: unknown) => T): unknown[] {
  switch (method) {
    case "push":
    case "unshift":
      return args.map(convert)
    case "splice":
      return [...args.slice(0, 2), ...args.slice(2).map(convert)]
    case "fill":
      return [convert(args[0]), ...args.slice(1)]
    default:
      return [...args]
  }
}

function indexError(index: number, length: number): RangeError {
  return new RangeError(`Failed to set the ${index} property on an ObservableArray: the index is beyond the length (${length}).`)
}

function lengthError(): RangeError {
  return new RangeError("Failed to set the 'length' property on an ObservableArray: it can only be made smaller.")
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

  // The change runs on a copy that replaces the contents only once it has not thrown, so a throw leaves the array as it was.
  const mutate = <R>(change: (draft: T[]) => R): R => {
    const draft = target.slice()
    const result = change(draft)
    if (changed(target, draft)) {
      target.length = 0
      for (const value of draft) target.push(value)
      onChange()
    }
    return result
  }

  const array: T[] = new Proxy(target, {
    get(_, key, receiver) {
      if (typeof key === "string" && MUTATORS.has(key)) {
        const method = Reflect.get(Array.prototype, key) as (...args: unknown[]) => unknown
        return (...args: unknown[]) => {
          const values = convertedArgs(key, args, convert)
          const result = mutate((draft) => ({ value: method.apply(draft, values), draft }))
          return result.value === result.draft ? receiver : result.value
        }
      }
      return Reflect.get(target, key, target)
    },
    set(_, key, value) {
      if (key === "length") {
        mutate((draft) => {
          draft.length = value
          if (draft.length > target.length) throw lengthError()
        })
        return true
      }
      const index = indexOf(key)
      if (index === undefined) return Reflect.set(target, key, value, target)
      const converted = convert(value)
      mutate((draft) => {
        if (index > draft.length) throw indexError(index, draft.length)
        draft[index] = converted
      })
      return true
    },
    defineProperty(_, key, descriptor) {
      const index = indexOf(key)
      if (index === undefined) return Reflect.defineProperty(target, key, descriptor)
      if (!("value" in descriptor)) return false
      const converted = convert(descriptor.value)
      mutate((draft) => {
        if (index > draft.length) throw indexError(index, draft.length)
        draft[index] = converted
      })
      return true
    },
    deleteProperty(_, key) {
      const index = indexOf(key)
      if (index === undefined) return Reflect.deleteProperty(target, key)
      if (index >= target.length) return true
      // A hole would leave an entry that is not a sheet, so only the last one can go.
      if (index !== target.length - 1) return false
      mutate((draft) => {
        draft.length = index
      })
      return true
    },
  })

  return {
    array,
    replace(values) {
      const converted = [...values].map(convert)
      mutate((draft) => {
        draft.splice(0, draft.length, ...converted)
      })
    },
  }
}
