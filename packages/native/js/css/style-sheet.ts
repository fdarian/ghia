import { styleDeclarationFor, styleFromCssText, type CSSStyleDeclaration } from "../dom/css-style-declaration.js"
import type { StyleDesc } from "../host.js"
import { splitRules, type RuleText } from "./rules.js"
import { allocateSheetId, sheetChanged, type SyncedSheet } from "./sheet-sync.js"

const RULE_TYPES: Readonly<Record<string, number>> = {
  "@import": 3,
  "@media": 4,
  "@font-face": 5,
  "@keyframes": 7,
  "@supports": 12,
}

const SHEET_OF = Symbol("@ghia/native/css/rule-sheet")
const RULES = Symbol("@ghia/native/css/rule-list")
const DEFINED = Symbol("@ghia/native/css/rule-list-defined")

function atRuleName(prelude: string): string {
  const match = /^@[^\s{(;"']*/.exec(prelude)
  return match ? match[0].toLowerCase() : ""
}

/** A rule of a sheet. `@layer`, `@container` and the other at-rules are this class, with `type` 0. */
export class CSSRule {
  static readonly STYLE_RULE = 1
  static readonly IMPORT_RULE = 3
  static readonly MEDIA_RULE = 4
  static readonly FONT_FACE_RULE = 5
  static readonly KEYFRAMES_RULE = 7
  static readonly SUPPORTS_RULE = 12

  readonly type: number
  readonly cssText: string
  readonly parentRule: CSSRule | null;
  [SHEET_OF]: CSSStyleSheet | null

  constructor(source: RuleText, sheet: CSSStyleSheet, parent: CSSRule | null = null) {
    this.parentRule = parent
    this.cssText = source.text
    this.type = source.atRule ? (RULE_TYPES[atRuleName(source.prelude)] ?? 0) : CSSRule.STYLE_RULE
    this[SHEET_OF] = sheet
  }

  get parentStyleSheet(): CSSStyleSheet | null {
    return this[SHEET_OF]
  }
}

/** A rule with a selector list. */
export class CSSStyleRule extends CSSRule {
  readonly selectorText: string
  private declared: StyleDesc | undefined

  constructor(source: RuleText, sheet: CSSStyleSheet, parent: CSSRule | null = null) {
    super(source, sheet, parent)
    this.selectorText = source.prelude
  }

  /**
   * The declarations of the rule, read from its text on the first read. A write changes this
   * declaration only: neither `cssText` nor what a renderer draws follows it.
   */
  get style(): CSSStyleDeclaration {
    const rule = this
    return styleDeclarationFor(rule, {
      get style() {
        return (rule.declared ??= styleFromCssText(rule.cssText.slice(rule.cssText.indexOf("{") + 1, rule.cssText.lastIndexOf("}"))))
      },
      setStyle(next) {
        rule.declared = next
      },
    })
  }
}

/** The live, read-only list `cssRules` is: array-like and iterable. */
export class CSSRuleList {
  readonly [index: number]: CSSRule;
  [RULES]: readonly CSSRule[] = [];
  /** How many index accessors the list has defined. */
  [DEFINED] = 0

  get length(): number {
    return this[RULES].length
  }

  item(index: number): CSSRule | null {
    return this[RULES][index >>> 0] ?? null
  }

  [Symbol.iterator](): Iterator<CSSRule> {
    return this[RULES][Symbol.iterator]()
  }
}

/**
 * Makes `list` show `rules`, an array the sheet may later splice in place. Each index is an accessor
 * that reads the array, so it is defined once and keeps answering as rules move: an insert or delete
 * only adds or drops the last index.
 */
function showRules(list: CSSRuleList, rules: readonly CSSRule[]): void {
  list[RULES] = rules
  for (let index = list[DEFINED]; index < rules.length; index++) {
    Object.defineProperty(list, index, { get: () => list[RULES][index], enumerable: true, configurable: true })
  }
  for (let index = rules.length; index < list[DEFINED]; index++) Reflect.deleteProperty(list, index)
  list[DEFINED] = rules.length
}

/** The rules between the braces of a grouping at-rule, as a rule list. Read-only: `insertRule` and `deleteRule` are the sheet's. */
function groupedRules(group: CSSRule, sheet: CSSStyleSheet): CSSRuleList {
  const list = new CSSRuleList()
  const text = group.cssText
  const inner = text.slice(text.indexOf("{") + 1, text.lastIndexOf("}"))
  showRules(
    list,
    splitRules(inner).map((rule) => makeRule(rule, sheet, group))
  )
  return list
}

/** `media.mediaText` of a `CSSMediaRule`: the comma-separated queries, as written. */
export class MediaList {
  readonly mediaText: string

  constructor(mediaText: string) {
    this.mediaText = mediaText
  }

  get length(): number {
    return this.queries().length
  }

  item(index: number): string | null {
    return this.queries()[index >>> 0] ?? null
  }

  toString(): string {
    return this.mediaText
  }

  private queries(): string[] {
    return this.mediaText === "" ? [] : this.mediaText.split(",").map((query) => query.trim())
  }
}

/** What follows the at-keyword in the prelude of an at-rule. */
function conditionOf(prelude: string): string {
  return prelude.replace(/^@[^\s{(;"']*/, "").trim()
}

/** `@media`: its queries and the rules it holds. */
export class CSSMediaRule extends CSSRule {
  readonly media: MediaList
  readonly cssRules: CSSRuleList

  constructor(source: RuleText, sheet: CSSStyleSheet, parent: CSSRule | null = null) {
    super(source, sheet, parent)
    this.media = new MediaList(conditionOf(source.prelude))
    this.cssRules = groupedRules(this, sheet)
  }

  get conditionText(): string {
    return this.media.mediaText
  }
}

/** `@supports`: its condition and the rules it holds. */
export class CSSSupportsRule extends CSSRule {
  readonly conditionText: string
  readonly cssRules: CSSRuleList

  constructor(source: RuleText, sheet: CSSStyleSheet, parent: CSSRule | null = null) {
    super(source, sheet, parent)
    this.conditionText = conditionOf(source.prelude)
    this.cssRules = groupedRules(this, sheet)
  }
}

function makeRule(source: RuleText, sheet: CSSStyleSheet, parent: CSSRule | null = null): CSSRule {
  if (!source.atRule) return new CSSStyleRule(source, sheet, parent)
  switch (atRuleName(source.prelude)) {
    case "@media":
      return new CSSMediaRule(source, sheet, parent)
    case "@supports":
      return new CSSSupportsRule(source, sheet, parent)
    default:
      return new CSSRule(source, sheet, parent)
  }
}

export interface CSSStyleSheetInit {
  baseURL?: string
  media?: unknown
  disabled?: boolean
}

function syntaxError(message: string): DOMException {
  return new DOMException(message, "SyntaxError")
}

/**
 * A constructed stylesheet. Native parses it, so JS keeps the rule texts for `cssRules` and sends the
 * whole sheet to every renderer that adopted it whenever it changes.
 */
export class CSSStyleSheet implements SyncedSheet {
  readonly id = allocateSheetId()
  readonly cssRules: CSSRuleList = new CSSRuleList()
  readonly ownerRule = null
  readonly parentStyleSheet = null
  readonly ownerNode = null
  readonly href = null
  readonly title = null
  readonly type = "text/css"
  private rules: CSSRule[] = []
  private disabledFlag: boolean

  constructor(options: CSSStyleSheetInit = {}) {
    this.disabledFlag = options.disabled === true
  }

  get disabled(): boolean {
    return this.disabledFlag
  }

  set disabled(value: boolean) {
    const next = Boolean(value)
    if (next === this.disabledFlag) return
    this.disabledFlag = next
    sheetChanged(this)
  }

  replaceSync(text: string): void {
    this.setRules(
      splitRules(String(text))
        .filter((rule) => atRuleName(rule.prelude) !== "@import")
        .map((rule) => makeRule(rule, this))
    )
  }

  replace(text: string): Promise<CSSStyleSheet> {
    const source = String(text)
    return Promise.resolve().then(() => {
      this.replaceSync(source)
      return this
    })
  }

  insertRule(rule: string, index = 0): number {
    const position = index >>> 0
    if (position > this.rules.length) {
      throw new DOMException(
        `Failed to execute 'insertRule' on 'CSSStyleSheet': The index provided (${position}) is larger than the maximum index (${this.rules.length}).`,
        "IndexSizeError"
      )
    }
    const parsed = splitRules(String(rule))
    if (parsed.length !== 1) {
      throw syntaxError(
        `Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '${rule}': it must be exactly one rule.`
      )
    }
    const inserted = parsed[0]!
    if (atRuleName(inserted.prelude) === "@import") {
      throw syntaxError("Failed to execute 'insertRule' on 'CSSStyleSheet': Can't insert @import rules into a constructed stylesheet.")
    }
    this.rules.splice(position, 0, makeRule(inserted, this))
    showRules(this.cssRules, this.rules)
    sheetChanged(this)
    return position
  }

  deleteRule(index: number): void {
    const position = index >>> 0
    if (position >= this.rules.length) {
      throw new DOMException(
        `Failed to execute 'deleteRule' on 'CSSStyleSheet': The index provided (${position}) is larger than the maximum index (${this.rules.length - 1}).`,
        "IndexSizeError"
      )
    }
    for (const removed of this.rules.splice(position, 1)) removed[SHEET_OF] = null
    showRules(this.cssRules, this.rules)
    sheetChanged(this)
  }

  sheetText(): string {
    return this.rules.map((rule) => rule.cssText).join("\n")
  }

  private setRules(rules: CSSRule[]): void {
    for (const old of this.rules) old[SHEET_OF] = null
    this.rules = rules
    showRules(this.cssRules, rules)
    sheetChanged(this)
  }
}
