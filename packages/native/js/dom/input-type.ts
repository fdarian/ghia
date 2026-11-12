/** The `type` keywords of `<input>` that are not the text state: anything else is `text`, as HTML says. */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "hidden", "search", "tel", "url", "email", "password", "date", "month", "week", "time", "datetime-local",
  "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button",
])

/**
 * The type state of an `<input>` from its `type` (an attribute or a prop): trimmed and lowercased as
 * native reads it (`InputType::parse`), with `text` for a missing, empty or unknown value.
 */
export function normalizedInputType(type: unknown): string {
  if (type === undefined || type === null) return "text"
  const keyword = String(type).trim().toLowerCase()
  return KNOWN_TYPES.has(keyword) ? keyword : "text"
}
