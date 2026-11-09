# Direct paint

An experiment, off by default: a plain host subtree is drawn by one gpui element that owns the nodes of the subtree, where each host would be a `Div`. It measures what removing the commit-to-`Div` translation gains on top of retention. Switch: `GPUIX_DIRECT_PAINT=1`, or `setDirectPaint(true)` on the test renderer; process wide and read at every build, so a subtree recorded before the switch changed is replayed as it was recorded.

The code is in `packages/native/src/render/`; `renderer.rs` has the one branch in the host arm of `build_element_unpumped` that asks `render::is_direct_root` and calls `render::build_direct` instead of `build_host_container`.

## What is built

A direct root resolves the style of every node it holds as the `Div` path does, in the same order and with the same inherited state (`Inherited::descend`, `style_cache::apply`, font features, direction, `position: static` by default), and keeps the result as a gpui `Style` in an arena (`render/node.rs`). Texts and paragraphs are built by the same `text_content` and `paragraph_content`, and are children of a node as they are of a `Div`. `DirectRoot` (`render/element.rs`) is the element: it requests one layout node per host in post order under the text style of its parent, prepaints with the text style, the hit mask of the overflow and the hitbox of each node, and paints with `Style::paint_box_with_effects` and the exact content mask, the calls `Div` makes.

A direct root is culled by its parent like a `Div` (`cull_outset` is what `build_host_container` gives `cullable`), and inside it a text is culled as a `Div` culls its children (`prepaint_unlifted_child`): a text outside the clip is prepainted as a culled subtree and draws nothing. gpui keeps `Window::lies_outside_the_mask` to itself, so `render/element.rs` restates it for a text's own box (no answer under a transform, and none while the pointer is captured, where gpui's never culls); a retained root that the reference build of `GPUIX_RETAIN_VERIFY` wraps is not culled by its parent and relies on that check, or its out-of-clip glyphs differ from a patched frame's.

The root keeps its entry in `Retain` and its `Retained`/`Taped` wrappers. A node below it has no entry: it leaves `Retain::unbuilt` (`direct_descendant`) so the spine does not hold the elements above it, and it counts in the size of the root, which is what decides whether a root is worth skipping. Everything an entry would have recorded for a plain node is recorded by the root or is nothing (see below). `getBuildCounters()` has `directRoots` and `directNodes`.

## What is direct

`render/eligible.rs`. A root is direct when the switch is on, the window's a11y is off (a direct node registers no accessibility node), and the root and everything it builds is plain:

- Types `div` and `text`, no custom prop, no listener, no focus, no `testId` beyond the locator.
- No positioned box, stacking context (`opacity`, `filter`, `mask`, `clip-path`, transforms, `z-index`), `visibility`, `app-region`, `user-select`, scroller (`overflow` other than `visible` or `clip`), container query or unit, `content-visibility`, custom property, transition, animation, text decoration or `text-box`; `display` is block, flex or grid.
- Below the root, no pointer state or group either. The root may have them: the build folds them in and the root has the hitbox that tells them.
- Children that are blocks, paragraphs of text and plain spans, and empty lines; no atomic inline, table box or `display: contents`.
- The context is plain: not a stacking root, an atomic inline, inside an `inert` or `visibility: hidden` subtree, a right-to-left one, a collapsed table, a highlight or a query container.

What a subtree is does not depend on what is above it and is remembered by the revision of the element; what it inherits is judged at the root.

## What a direct node has

Each node does what a `Div` host does for the pointer and for the bounds registries, in the same order, with its state in the arena node (gpui moves an element's own prepaint state by value, so nothing per node lives there).

- **Hitbox.** `prepaint_node` pushes the host element id of the node (`Window::with_id` along the arena, as the id stack of a `Div` has it, which is what names the hitbox: `host_hit_chain` maps the hit to the descendant, so the `target` of an event is the node under the pointer and a `composedPath` has the nodes between it and the root). A node gets one where `Interactivity::should_insert_hitbox` gives a host that is not a text node one: the window has DOM hit testing on, the node is `pointer-events: none` (the hitbox is then `PassThrough`, only a link in the chain of a descendant that is hit, and `auto` below it reopens), or it has a cursor. Its shape is the border box with the corner radii of the style (`border_box_radii`, which gpui keeps to itself, is restated in `element.rs`), and its children are prepainted under `with_hitbox_parent`.
- **Cursor.** Paint calls `set_cursor_style` with the hitbox, unless the platform has a drag in flight (files dragged in from outside), where a `Div` sets none.
- **Bounds.** What `HostBoundsProbe` does for a `Div`, shared in `automation.rs` (`read_layout`, `paint_host_bounds`, `publish_host_bounds`, `host_bounds_flags`): the box is read where layout left it in prepaint; paint notes the layout node and records the box (and the start region of a node that declares `user-select`, which is not direct yet); a pass that does not paint (a read, a patch prepared ahead) reports the box from prepaint through `Window::publish_layout`, and a culled node does both as a `Div` in a culled subtree does. `getElementBounds`, `getBoundingClientRect` and the observers see a direct node as a host.

Not done: gpui's `Window::note_publication`, which a `Div` calls before it hands the layout probe a sample, is crate private, so a recording that holds the boxes of direct nodes is not counted as one that publishes; the box writes are on the tape of the root, which the replay translates. A retention mismatch that shows a replayed frame without a box would be this.

## What a direct node does not have yet

No lifting, no accessibility node, no element state, and no listener, focus or scroller of its own. A subtree that needs one of those is not direct. See [deviations.md](deviations.md#direct-paint).
