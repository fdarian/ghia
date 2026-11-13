/// GPUIX JSX runtime types — maps intrinsic elements to GPUIX Props
/// instead of DOM types. Activated via "jsxImportSource": "@ghia/react".
///
/// `key` is declared on `Props`, not on `IntrinsicAttributes` below.
/// TypeScript 5 ignores `IntrinsicAttributes` for intrinsic elements.

import type * as React from "react"
import type {
  AnchoredProps,
  CodeProps,
  DiffProps,
  FormInstance,
  FormProps,
  HostRef,
  HtmlAnchorProps,
  HtmlButtonProps,
  HtmlTag,
  ImgInstance,
  ImgProps,
  InputProps,
  LabelProps,
  MarkdownProps,
  NativeviewProps,
  Props,
  PublicInstance,
  SvgCircleProps,
  SvgClipPathProps,
  SvgDefsProps,
  SvgEllipseProps,
  SvgGradientProps,
  SvgGroupProps,
  SvgLineProps,
  SvgMaskProps,
  SvgPathProps,
  SvgPolyProps,
  SvgProps,
  SvgRectProps,
  SvgStopProps,
  SvgSymbolProps,
  SvgUseProps,
  WebviewProps,
  SvgTextProps,
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
  TextControlInstance,
  VirtualListProps,
  WebviewInstance,
} from "./dist/types/host"

export { jsx, jsxs, Fragment } from "react/jsx-runtime"

/** The HTML tags that lay out as a `div` or a `span`, each with its own DOM interface for `ref`. */
type HtmlTagElements = { [Tag in HtmlTag]: JSX.Host<Props, Tag> }

export namespace JSX {
  type ElementType = React.JSX.ElementType
  type Element = React.JSX.Element
  type ElementClass = React.JSX.ElementClass
  type ElementAttributesProperty = React.JSX.ElementAttributesProperty
  type ElementChildrenAttribute = React.JSX.ElementChildrenAttribute
  type IntrinsicAttributes = React.JSX.IntrinsicAttributes
  type IntrinsicClassAttributes<T> = React.JSX.IntrinsicClassAttributes<T>

  /**
   * A host element's props, with the `ref` of its tag: a ref object of Ghia's instance type or of the tag's DOM
   * interface, or a callback given both (see `HostRef`).
   */
  type Host<P, Tag extends string, Instance = PublicInstance> = Omit<P, "ref"> & { ref?: HostRef<Instance, Tag> }

  interface IntrinsicElements extends HtmlTagElements {
    a: Host<Props & HtmlAnchorProps, "a">
    button: Host<Props & HtmlButtonProps, "button">
    div: Host<Props, "div">
    text: Host<SvgTextProps, "text">
    span: Host<Props, "span">
    img: Host<ImgProps, "img", ImgInstance>
    webview: Host<WebviewProps, "webview", WebviewInstance>
    nativeview: Host<NativeviewProps, "nativeview">
    svg: Host<SvgProps, "svg">
    path: Host<SvgPathProps, "path">
    circle: Host<SvgCircleProps, "circle">
    ellipse: Host<SvgEllipseProps, "ellipse">
    rect: Host<SvgRectProps, "rect">
    line: Host<SvgLineProps, "line">
    polyline: Host<SvgPolyProps, "polyline">
    polygon: Host<SvgPolyProps, "polygon">
    g: Host<SvgGroupProps, "g">
    defs: Host<SvgDefsProps, "defs">
    linearGradient: Host<SvgGradientProps, "linearGradient">
    radialGradient: Host<SvgGradientProps, "radialGradient">
    stop: Host<SvgStopProps, "stop">
    clipPath: Host<SvgClipPathProps, "clipPath">
    mask: Host<SvgMaskProps, "mask">
    use: Host<SvgUseProps, "use">
    symbol: Host<SvgSymbolProps, "symbol">
    pattern: Host<SvgPatternProps, "pattern">
    marker: Host<SvgMarkerProps, "marker">
    image: Host<SvgImageProps, "image">
    tspan: Host<SvgTspanProps, "tspan">
    textPath: Host<SvgTextPathProps, "textPath">
    filter: Host<SvgFilterProps, "filter">
    feBlend: Host<SvgFeBlendProps, "feBlend">
    feColorMatrix: Host<SvgFeColorMatrixProps, "feColorMatrix">
    feComponentTransfer: Host<SvgFeComponentTransferProps, "feComponentTransfer">
    feFuncR: Host<SvgFeFuncProps, "feFuncR">
    feFuncG: Host<SvgFeFuncProps, "feFuncG">
    feFuncB: Host<SvgFeFuncProps, "feFuncB">
    feFuncA: Host<SvgFeFuncProps, "feFuncA">
    feComposite: Host<SvgFeCompositeProps, "feComposite">
    feConvolveMatrix: Host<SvgFeConvolveMatrixProps, "feConvolveMatrix">
    feDiffuseLighting: Host<SvgFeDiffuseLightingProps, "feDiffuseLighting">
    feDisplacementMap: Host<SvgFeDisplacementMapProps, "feDisplacementMap">
    feDistantLight: Host<SvgFeDistantLightProps, "feDistantLight">
    feDropShadow: Host<SvgFeDropShadowProps, "feDropShadow">
    feFlood: Host<SvgFeFloodProps, "feFlood">
    feGaussianBlur: Host<SvgFeGaussianBlurProps, "feGaussianBlur">
    feImage: Host<SvgFeImageProps, "feImage">
    feMerge: Host<SvgFeMergeProps, "feMerge">
    feMergeNode: Host<SvgFeMergeNodeProps, "feMergeNode">
    feMorphology: Host<SvgFeMorphologyProps, "feMorphology">
    feOffset: Host<SvgFeOffsetProps, "feOffset">
    fePointLight: Host<SvgFePointLightProps, "fePointLight">
    feSpecularLighting: Host<SvgFeSpecularLightingProps, "feSpecularLighting">
    feSpotLight: Host<SvgFeSpotLightProps, "feSpotLight">
    feTile: Host<SvgFeTileProps, "feTile">
    feTurbulence: Host<SvgFeTurbulenceProps, "feTurbulence">
    canvas: Host<Props, "canvas">
    /** A stylesheet: its text children are the CSS. It is never drawn. */
    style: Host<Props, "style">
    input: Host<InputProps, "input", TextControlInstance>
    textarea: Host<TextareaProps, "textarea", TextControlInstance>
    label: Host<LabelProps, "label">
    form: Host<FormProps, "form", FormInstance>
    anchored: Host<AnchoredProps, "anchored">
    code: Host<CodeProps, "code">
    diff: Host<DiffProps, "diff">
    markdown: Host<MarkdownProps, "markdown">
    "virtual-list": Host<VirtualListProps, "virtual-list">
  }
}
