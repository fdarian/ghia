import { parseHtmlDocument } from "./parse.js"
import type { Document } from "../nodes.js"

const XML_TYPES: ReadonlySet<string> = new Set(["text/xml", "application/xml", "application/xhtml+xml", "image/svg+xml"])

/**
 * `new DOMParser().parseFromString(markup, "text/html")`: the document a browser makes of the
 * markup, without a window. It is made of the same DOM classes as `document` and is never rendered;
 * see `inert-nodes.ts`. The XML types are not supported.
 */
export class DOMParser {
  parseFromString(string: string, type: string): Document {
    const mime = String(type)
    if (mime === "text/html") return parseHtmlDocument(String(string)) as unknown as Document
    if (XML_TYPES.has(mime)) {
      throw new DOMException(`DOMParser cannot parse "${mime}": Ghia has no XML parser, only "text/html".`, "NotSupportedError")
    }
    throw new TypeError(`Failed to execute 'parseFromString' on 'DOMParser': The provided value '${mime}' is not a valid enum value of type DOMParserSupportedType.`)
  }
}
