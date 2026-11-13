/**
 * The DOM interface of a tag's element, as lib.dom names it: `HTMLDivElement` for `div`, `HTMLInputElement` for
 * `input`, `SVGPathElement` for `path`. The adapters type a host `ref` with it, so a ref written for React DOM or
 * Solid on the web (`useRef<HTMLDivElement>`, `let el!: HTMLDivElement`) fits as it is, and a library that takes an
 * `Element` (`@tanstack/react-virtual`'s `measureElement`) takes the element a ref gives.
 *
 * A tag lib.dom does not know (`webview`, `virtual-list`, `anchored`) is an `HTMLElement`, and so is `canvas`, which
 * has no drawing context here. The maps come from lib.dom: in a program without the DOM lib they are the empty
 * interfaces declared below, and every tag is `HTMLElement`, which is then empty too, so a ref is Ghia's own type.
 */
export type DomElementOf<Tag extends string> = Tag extends "canvas"
  ? HTMLElement
  : Tag extends keyof HTMLElementTagNameMap
    ? HTMLElementTagNameMap[Tag]
    : Tag extends keyof SVGElementTagNameMap
      ? SVGElementTagNameMap[Tag]
      : HTMLElement

// Empty, so they merge with lib.dom's where the program has it and stand in for them where it does not.
declare global {
  interface HTMLElement {}
  interface HTMLElementTagNameMap {}
  interface SVGElementTagNameMap {}
}
