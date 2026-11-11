/**
 * Copies every own member of `source` except the constructor onto `target`. An adapter makes its
 * SVG element class this way: an `SVGElement` subclass needs the members its HTML element class
 * defines, and a class can have one base.
 */
export function copyPrototypeMembers(source: object, target: object): void {
  for (const key of Reflect.ownKeys(source)) {
    if (key === "constructor") continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor === undefined) throw new Error(`The source has no own ${String(key)}`)
    Object.defineProperty(target, key, descriptor)
  }
}
