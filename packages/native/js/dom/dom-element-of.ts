/**
 * The DOM interface of a tag's element, as lib.dom names it: `HTMLDivElement` for `div`, `HTMLInputElement` for
 * `input`, `SVGPathElement` for `path`. The adapters type a host `ref` with it, so a ref written for React DOM or
 * Solid on the web (`useRef<HTMLDivElement>`, `let el!: HTMLDivElement`) fits as it is, and a library that takes an
 * `Element` (`@tanstack/react-virtual`'s `measureElement`) takes the element a ref gives.
 *
 * A tag lib.dom does not know (`webview`, `virtual-list`, `anchored`) is an `HTMLElement`, and so is `canvas`, which
 * has no drawing context here. In a program without the DOM lib there is no DOM interface to name, and every tag is
 * `never`: the adapters then type a ref with Ghia's own type alone (see `RefElementOf`).
 */
export type DomElementOf<Tag extends string> = HasDomLib extends false
  ? never
  : Tag extends "canvas"
    ? HTMLElement
    : Tag extends keyof HTMLElementTagNameMap
      ? HTMLElementTagNameMap[Tag]
      : Tag extends keyof SVGElementTagNameMap
        ? SVGElementTagNameMap[Tag]
        : HTMLElement

/** What a callback ref is given beside Ghia's own type: the tag's DOM interface, or nothing more without the DOM lib. */
export type RefElementOf<Tag extends string> = [DomElementOf<Tag>] extends [never] ? unknown : DomElementOf<Tag>

/** Whether the program has lib.dom: its tag map is the empty stand-in below otherwise (`@types/react` declares none). */
type HasDomLib = "div" extends keyof HTMLElementTagNameMap ? true : false

// Empty, so they merge with lib.dom's where the program has it and stand in for them, empty, where it does not.
declare global {
  interface HTMLElement {}
  interface HTMLElementTagNameMap {}
  interface SVGElementTagNameMap {}
}
