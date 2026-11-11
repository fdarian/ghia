/**
 * Splits sheet text into its top-level rules, the way a CSS parser finds where each one ends,
 * without interpreting what is inside. Native parses the same text for matching; this only has to
 * agree with it on where rules begin and end, so `cssRules` lists what native sees.
 */

export interface RuleText {
  /** The rule as written, from its first character to its closing `}` or `;`. */
  readonly text: string
  /** The text before the block, trimmed: the selector list of a style rule, the name and prelude of an at-rule. */
  readonly prelude: string
  readonly atRule: boolean
}

function skipComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2)
  return end === -1 ? text.length : end + 2
}

interface StringScan {
  /** Index just past the string. */
  readonly end: number
  /** False when the text ended inside it. */
  readonly closed: boolean
}

function scanString(text: string, start: number): StringScan {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") index += 2
    else if (char === quote || char === "\n") return { end: index + 1, closed: true }
    else index++
  }
  return { end: text.length, closed: false }
}

const CLOSERS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" }

interface RuleScan {
  /** Index just past the rule. */
  readonly end: number
  /** Index of the `{` that opens the rule's block, or -1. */
  readonly blockAt: number
  /** What the text left open at its end needs to be well formed, as a browser serializes it. */
  readonly closing: string
}

/**
 * The rule that starts at `start`. A style rule ends at the `}` that closes its first block; an
 * at-rule ends there or at a `;` outside any block, which is how `@layer a, b;` is a rule.
 */
function scanRule(text: string, start: number, atRule: boolean): RuleScan {
  const open: string[] = []
  let depth = 0
  let blockAt = -1
  let index = start
  const unfinished = (inside: string): RuleScan => ({
    end: text.length,
    blockAt,
    closing: inside + open.reverse().map((closer) => (closer === "}" ? " }" : closer)).join("") + (atRule && blockAt === -1 ? ";" : ""),
  })
  while (index < text.length) {
    const char = text[index]!
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      const string = scanString(text, index)
      if (!string.closed) return unfinished(char)
      index = string.end
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      const close = text.indexOf("*/", index + 2)
      if (close === -1) return unfinished(" */")
      index = close + 2
      continue
    }
    if (char === "(" || char === "[") open.push(CLOSERS[char]!)
    else if ((char === ")" || char === "]") && open.at(-1) === char) open.pop()
    else if (char === "{") {
      if (depth === 0) blockAt = index
      depth++
      open.push("}")
    } else if (char === "}") {
      depth--
      if (depth <= 0) return { end: index + 1, blockAt, closing: "" }
      open.length = open.lastIndexOf("}")
    } else if (char === ";" && depth === 0 && open.length === 0 && atRule) {
      return { end: index + 1, blockAt, closing: "" }
    }
    index++
  }
  return unfinished("")
}

/** `text` with its comments removed, trimmed. */
function withoutComments(text: string): string {
  let result = ""
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "/" && text[index + 1] === "*") {
      index = skipComment(text, index)
    } else if (char === '"' || char === "'") {
      const end = scanString(text, index).end
      result += text.slice(index, end)
      index = end
    } else {
      result += char
      index++
    }
  }
  return result.trim()
}

export function splitRules(text: string): RuleText[] {
  const rules: RuleText[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "/" && text[index + 1] === "*") {
      index = skipComment(text, index)
      continue
    }
    if (/\s/.test(char)) {
      index++
      continue
    }
    if (char === "<" && text.startsWith("<!--", index)) {
      index += 4
      continue
    }
    if (char === "-" && text.startsWith("-->", index)) {
      index += 3
      continue
    }
    // Nothing is open at the top level, so a `}` here closes nothing: skip it, and the rules after it stay.
    if (char === "}") {
      index++
      continue
    }
    const atRule = char === "@"
    const found = scanRule(text, index, atRule)
    if (!atRule && found.blockAt === -1) break
    const source = text.slice(index, found.end).trim() + found.closing
    const preludeEnd = found.blockAt === -1 ? found.end : found.blockAt
    let prelude = withoutComments(text.slice(index, preludeEnd))
    if (found.blockAt === -1 && prelude.endsWith(";")) prelude = prelude.slice(0, -1).trimEnd()
    rules.push({ text: source, prelude, atRule })
    index = found.end
  }
  return rules
}
