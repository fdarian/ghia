/** DOMException is missing from some embedded runtimes such as Hermes. */
export function namedError(name: string, message: string): Error {
  if (typeof DOMException === "function") return new DOMException(message, name)
  const error = new Error(message)
  error.name = name
  return error
}
