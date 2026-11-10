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

function skipString(text: string, start: number): number {
  const quote = text[start]
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") index += 2
    else if (char === quote || char === "\n") return index + 1
    else index++
  }
  return text.length
}

/**
 * Index just past the rule that starts at `start`. A style rule ends at the `}` that closes its first
 * block; an at-rule ends there or at a `;` outside any block, which is how `@layer a, b;` is a rule.
 */
function ruleEnd(text: string, start: number, atRule: boolean): { end: number; blockAt: number } {
  let depth = 0
  let parens = 0
  let blockAt = -1
  let index = start
  while (index < text.length) {
    const char = text[index]
    if (char === "\\") {
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      index = skipString(text, index)
      continue
    }
    if (char === "/" && text[index + 1] === "*") {
      index = skipComment(text, index)
      continue
    }
    if (char === "(" || char === "[") parens++
    else if (char === ")" || char === "]") parens = Math.max(0, parens - 1)
    else if (char === "{") {
      if (depth === 0) blockAt = index
      depth++
    } else if (char === "}") {
      depth--
      if (depth <= 0) return { end: index + 1, blockAt }
    } else if (char === ";" && depth === 0 && parens === 0 && atRule) {
      return { end: index + 1, blockAt }
    }
    index++
  }
  return { end: text.length, blockAt }
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
      const end = skipString(text, index)
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
    const atRule = char === "@"
    const found = ruleEnd(text, index, atRule)
    const source = text.slice(index, found.end).trim()
    const preludeEnd = found.blockAt === -1 ? found.end : found.blockAt
    let prelude = withoutComments(text.slice(index, preludeEnd))
    if (found.blockAt === -1 && prelude.endsWith(";")) prelude = prelude.slice(0, -1).trimEnd()
    rules.push({ text: source, prelude, atRule })
    index = found.end
  }
  return rules
}
