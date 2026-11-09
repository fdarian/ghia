# Direct paint

An experiment, off by default: a plain host subtree is drawn by one gpui element that owns the nodes of the subtree, where each host would be a `Div`. It measures what removing the commit-to-`Div` translation gains on top of retention. Switch: `GPUIX_DIRECT_PAINT=1`, or `setDirectPaint(true)` on the test renderer; process wide and read at every build, so a subtree recorded before the switch changed is replayed as it was recorded.

The code is in `packages/native/src/render/`; `renderer.rs` has the one branch in the host arm of `build_element_unpumped` that asks `render::is_direct_root` and calls `render::build_direct` instead of `build_host_container`.

## What is built

A direct root resolves the style of every node it holds as the `Div` path does, in the same order and with the same inherited state (`Inherited::descend`, `style_cache::apply`, font features, direction, `position: static` by default), and keeps the result as a gpui `Style` in an arena (`render/node.rs`). Texts and paragraphs are built by the same `text_content` and `paragraph_content`, and are children of a node as they are of a `Div`. `DirectRoot` (`render/element.rs`) is the element: it requests one layout node per host in post order under the text style of its parent, prepaints with the text style, the hit mask of the overflow and (for the root only) the hitbox, and paints with `Style::paint_box_with_effects` and the exact content mask, the calls `Div` makes.

The root keeps its entry in `Retain` and its `Retained`/`Taped` wrappers. A node below it has no entry: it leaves `Retain::unbuilt` (`direct_descendant`) so the spine does not hold the elements above it, and it counts in the size of the root, which is what decides whether a root is worth skipping. Everything an entry would have recorded for a plain node is recorded by the root or is nothing (see below). `getBuildCounters()` has `directRoots` and `directNodes`.

## What is direct

`render/eligible.rs`. A root is direct when the switch is on, the window's a11y is off (a direct node registers no accessibility node), and the root and everything it builds is plain:

- Types `div` and `text`, no custom prop, no listener, no focus, no `testId` beyond the locator.
- No positioned box, stacking context (`opacity`, `filter`, `mask`, `clip-path`, transforms, `z-index`), `visibility`, cursor, `pointer-events`, `app-region`, `user-select`, scroller (`overflow` other than `visible` or `clip`), container query or unit, `content-visibility`, custom property, transition, animation, text decoration or `text-box`; `display` is block, flex or grid.
- Below the root, no pointer state or group either. The root may have them: the build folds them in and the root has the hitbox that tells them.
- Children that are blocks, paragraphs of text and plain spans, and empty lines; no atomic inline, table box or `display: contents`.
- The context is plain: not a stacking root, an atomic inline, inside an `inert` or `pointer-events: none` or `visibility: hidden` subtree, a right-to-left one, a collapsed table, a highlight or a query container.

What a subtree is does not depend on what is above it and is remembered by the revision of the element; what it inherits is judged at the root.

## What a direct node does not have yet

Slice 1 of the experiment has no hitbox below the root (the pointer is over the root, so an event's `target` is the root and a descendant is never hovered), no bounds or start-region record (`getElementBounds` is null for a descendant, and so are the observers that read it), and no lifting. A subtree that needs one of those is not direct. See [deviations.md](deviations.md#direct-paint).
