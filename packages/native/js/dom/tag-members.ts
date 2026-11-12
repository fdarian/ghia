/**
 * A member that only some tags have: on the others it reads `undefined` and an assignment makes a
 * plain property, as it was before the accessor existed, so no other element changes.
 */
export function onTags<This extends object>(
  name: string,
  tags: ReadonlySet<string>,
  read: (self: This) => unknown,
  write: (self: This, value: unknown) => void
) {
  return {
    configurable: true,
    get(this: This) {
      return tags.has(Reflect.get(this, "localName") as string) ? read(this) : undefined
    },
    set(this: This, value: unknown) {
      if (tags.has(Reflect.get(this, "localName") as string)) write(this, value)
      else Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true })
    },
  }
}
