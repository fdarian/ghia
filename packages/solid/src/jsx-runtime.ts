import type { JSX as SolidJSX } from "solid-js"
import type {
  AnchoredProps,
  CodeProps,
  DiffProps,
  DomElementOf,
  FormProps,
  HostProps,
  HtmlAnchorProps,
  HtmlButtonProps,
  HtmlTag,
  ImgProps,
  InputProps,
  LabelProps,
  MarkdownProps,
  MotionProps,
  MotionValueStyle,
  NativeviewProps,
  RefElementOf,
  SvgMotionProps,
  SvgCircleProps,
  SvgClipPathProps,
  SvgDefsProps,
  SvgEllipseProps,
  SvgGradientProps,
  SvgGroupProps,
  SvgLineProps,
  SvgPathProps,
  SvgPolyProps,
  SvgProps,
  SvgMaskProps,
  SvgRectProps,
  SvgStopProps,
  SvgSymbolProps,
  SvgUseProps,
  SvgTextProps,
  WebviewProps,
  SvgPatternProps,
  SvgMarkerProps,
  SvgImageProps,
  SvgTspanProps,
  SvgTextPathProps,
  SvgFilterProps,
  SvgFeBlendProps,
  SvgFeColorMatrixProps,
  SvgFeComponentTransferProps,
  SvgFeFuncProps,
  SvgFeCompositeProps,
  SvgFeConvolveMatrixProps,
  SvgFeDiffuseLightingProps,
  SvgFeDisplacementMapProps,
  SvgFeDistantLightProps,
  SvgFeDropShadowProps,
  SvgFeFloodProps,
  SvgFeGaussianBlurProps,
  SvgFeImageProps,
  SvgFeMergeProps,
  SvgFeMergeNodeProps,
  SvgFeMorphologyProps,
  SvgFeOffsetProps,
  SvgFePointLightProps,
  SvgFeSpecularLightingProps,
  SvgFeSpotLightProps,
  SvgFeTileProps,
  SvgFeTurbulenceProps,
  TextareaProps,
  VirtualListProps,
} from "@ghia/native/host"
import { createComponent, createElement, spread } from "./universal.js"
import type { HostElement } from "./host.js"

/**
 * The `ref` of a host element of tag `Tag`: a variable typed with Ghia's `HostElement` or with the tag's DOM interface
 * (`let el!: HTMLDivElement`) takes the element, and a callback is given it as both, so a callback typed for either
 * (`measureElement`'s `(node: Element) => void`) fits. Without a tag (`string`) it is a `HostElement`, which fits the
 * `ref` of every tag, so props of that type can be spread on any element; without the DOM lib it is that too.
 */
export type SolidHostRef<Tag extends string> = string extends Tag
  ? HostElement | ((element: HostElement) => void)
  : HostElement | DomElementOf<Tag> | ((element: HostElement & RefElementOf<Tag>) => void)

/** A host element's props in Solid JSX, with the `ref` of `Tag` (see `SolidHostRef`). */
export type SolidHostProps<Props = HostProps, Tag extends string = string> = Omit<Props, "style"> & {
  style?: MotionValueStyle
  children?: SolidJSX.Element
  /** The `class` attribute, which stylesheet rules (`.name`) match. */
  class?: string
  /** Adds each key whose value is truthy to the `class` attribute, and takes away one that is no longer. */
  classList?: { [name: string]: boolean | undefined }
  ref?: SolidHostRef<Tag>
}

type Component = (props: Record<string, unknown>) => unknown

function normalizeProps(props: Record<string, unknown> | null | undefined) {
  if (!props || !("key" in props)) return props ?? {}
  const { key: _key, ...rest } = props
  return rest
}

export function jsx(
  type: string | Component,
  props?: Record<string, unknown> | null
): SolidJSX.Element {
  const normalized = normalizeProps(props)
  if (typeof type === "function") {
    return createComponent(type as never, normalized) as never
  }
  const element = createElement(type)
  spread(element, normalized)
  return element as never
}

export const jsxs = jsx
export const jsxDEV = jsx
export function Fragment(props: { children?: unknown }): SolidJSX.Element {
  return (props.children ?? null) as SolidJSX.Element
}

/** The HTML tags that lay out as a `div` or a `span`, each with its own DOM interface for `ref`. */
type HtmlTagElements = { [Tag in HtmlTag]: SolidHostProps<HostProps, Tag> }

export namespace JSX {
  export type Element = SolidJSX.Element
  export interface ElementChildrenAttribute { children: {} }
  export interface IntrinsicElements extends HtmlTagElements {
    a: SolidHostProps<HostProps & HtmlAnchorProps, "a">
    button: SolidHostProps<HostProps & HtmlButtonProps, "button">
    div: SolidHostProps<HostProps, "div">
    text: SolidHostProps<SvgTextProps, "text">
    span: SolidHostProps<HostProps, "span">
    img: SolidHostProps<ImgProps, "img">
    webview: SolidHostProps<WebviewProps, "webview">
    nativeview: SolidHostProps<NativeviewProps, "nativeview">
    svg: SolidHostProps<SvgProps, "svg">
    path: SolidHostProps<SvgPathProps, "path">
    circle: SolidHostProps<SvgCircleProps, "circle">
    ellipse: SolidHostProps<SvgEllipseProps, "ellipse">
    rect: SolidHostProps<SvgRectProps, "rect">
    line: SolidHostProps<SvgLineProps, "line">
    polyline: SolidHostProps<SvgPolyProps, "polyline">
    polygon: SolidHostProps<SvgPolyProps, "polygon">
    g: SolidHostProps<SvgGroupProps, "g">
    defs: SolidHostProps<SvgDefsProps, "defs">
    linearGradient: SolidHostProps<SvgGradientProps, "linearGradient">
    radialGradient: SolidHostProps<SvgGradientProps, "radialGradient">
    stop: SolidHostProps<SvgStopProps, "stop">
    clipPath: SolidHostProps<SvgClipPathProps, "clipPath">
    mask: SolidHostProps<SvgMaskProps, "mask">
    use: SolidHostProps<SvgUseProps, "use">
    symbol: SolidHostProps<SvgSymbolProps, "symbol">
    pattern: SolidHostProps<SvgPatternProps, "pattern">
    marker: SolidHostProps<SvgMarkerProps, "marker">
    image: SolidHostProps<SvgImageProps, "image">
    tspan: SolidHostProps<SvgTspanProps, "tspan">
    textPath: SolidHostProps<SvgTextPathProps, "textPath">
    filter: SolidHostProps<SvgFilterProps, "filter">
    feBlend: SolidHostProps<SvgFeBlendProps, "feBlend">
    feColorMatrix: SolidHostProps<SvgFeColorMatrixProps, "feColorMatrix">
    feComponentTransfer: SolidHostProps<SvgFeComponentTransferProps, "feComponentTransfer">
    feFuncR: SolidHostProps<SvgFeFuncProps, "feFuncR">
    feFuncG: SolidHostProps<SvgFeFuncProps, "feFuncG">
    feFuncB: SolidHostProps<SvgFeFuncProps, "feFuncB">
    feFuncA: SolidHostProps<SvgFeFuncProps, "feFuncA">
    feComposite: SolidHostProps<SvgFeCompositeProps, "feComposite">
    feConvolveMatrix: SolidHostProps<SvgFeConvolveMatrixProps, "feConvolveMatrix">
    feDiffuseLighting: SolidHostProps<SvgFeDiffuseLightingProps, "feDiffuseLighting">
    feDisplacementMap: SolidHostProps<SvgFeDisplacementMapProps, "feDisplacementMap">
    feDistantLight: SolidHostProps<SvgFeDistantLightProps, "feDistantLight">
    feDropShadow: SolidHostProps<SvgFeDropShadowProps, "feDropShadow">
    feFlood: SolidHostProps<SvgFeFloodProps, "feFlood">
    feGaussianBlur: SolidHostProps<SvgFeGaussianBlurProps, "feGaussianBlur">
    feImage: SolidHostProps<SvgFeImageProps, "feImage">
    feMerge: SolidHostProps<SvgFeMergeProps, "feMerge">
    feMergeNode: SolidHostProps<SvgFeMergeNodeProps, "feMergeNode">
    feMorphology: SolidHostProps<SvgFeMorphologyProps, "feMorphology">
    feOffset: SolidHostProps<SvgFeOffsetProps, "feOffset">
    fePointLight: SolidHostProps<SvgFePointLightProps, "fePointLight">
    feSpecularLighting: SolidHostProps<SvgFeSpecularLightingProps, "feSpecularLighting">
    feSpotLight: SolidHostProps<SvgFeSpotLightProps, "feSpotLight">
    feTile: SolidHostProps<SvgFeTileProps, "feTile">
    feTurbulence: SolidHostProps<SvgFeTurbulenceProps, "feTurbulence">
    canvas: SolidHostProps<HostProps, "canvas">
    /** A stylesheet: its text children are the CSS. It is never drawn. */
    style: SolidHostProps<HostProps, "style">
    input: SolidHostProps<InputProps, "input">
    textarea: SolidHostProps<TextareaProps, "textarea">
    label: SolidHostProps<LabelProps, "label">
    form: SolidHostProps<FormProps, "form">
    anchored: SolidHostProps<AnchoredProps, "anchored">
    code: SolidHostProps<CodeProps, "code">
    diff: SolidHostProps<DiffProps, "diff">
    markdown: SolidHostProps<MarkdownProps, "markdown">
    "virtual-list": SolidHostProps<VirtualListProps, "virtual-list">
  }
}

export type { MotionProps, SvgMotionProps }
