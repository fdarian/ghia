# `<nativeview>`: a native view from another library between the GPUI layers

`<nativeview>` is a `div` with a native layer in it. A separate library (its own napi addon, with no link to GPUI) puts any AppKit view there: an `NSVisualEffectView`, a `CAMetalLayer`-backed view, a map, a glass effect. gpuix owns the placeholder, the layer order, the geometry, the clipping, the pointer and the React and Solid wiring; the library owns its view. The element knows nothing about what the view is. `docs/reference.md` ([`<nativeview>`](../reference.md#nativeview)) holds what an app sees; this file holds how a library uses it and why it works as it does. What does not match the DOM is in [deviations.md](deviations.md#nativeview).

macOS only. Other platforms get an empty box that lays out its children, and a warning once; `onAttach` is never called.

## Why a pointer and the Objective-C runtime

A library addon cannot share GPUI types with gpuix's addon: there is no stable Rust ABI, and `custom_elements` is private to gpuix's crate. What both sides can name is an `NSView` and the Objective-C runtime. So the whole boundary is one number: the address of the element's content view, which gpuix hands to JS (`onAttach`) as a `bigint` and JS hands to the library. Nothing of gpuix crosses it, and the library needs no per-frame code: it fills the content view and gpuix moves, clips and hides the container the content view is in.

It is the surface of [`<webview>`](webview.md), made generic. `<webview>` stays a built-in element (Tab handoff, page events); the two share the composition in zed and the radius helpers (`custom_elements/native_surface.rs`) and nothing else.

## Using it

```tsx
<nativeview style={style} nativeEvents onAttach={(view) => library.attach(view)} onDetach={() => library.detach()}>
  {children}
</nativeview>
```

- `onAttach(view: bigint)`: the surface exists. `view` is the content `NSView` of the surface, already the size of the element's padding box. It is called once per element, **synchronously, inside the frame that makes the surface**: in its prepaint, before that frame is drawn and presented, so the view the library adds is in the container when the frame places it (see [Why `onAttach` runs inside the frame](#why-onattach-runs-inside-the-frame)). It is not called at all if the element is gone before its first frame.
- `onDetach()`: the surface is about to be taken down. Called synchronously, before the unmount (inside the batch that destroys the element) or the window close continues, and exactly once for every `onAttach`. `display: none` hides the surface and does not detach; a keyed reorder does not detach.
- `nativeEvents`: see [Pointer](#pointer).
- Everything else is a `div`: `style`, children, handlers, `ref`, `aria-*`.

### The lifetime rule

The pointer is valid from `onAttach` until `onDetach` returns. **In `onDetach` the library must remove its view from the content view and release it. Using the pointer afterwards is undefined and can crash:** the container is released right after `onDetach` returns, and nothing checks the pointer on the JS side. There is no retained-handle object. `onDetach` runs inside a call gpuix is in the middle of (an `applyBatch`, the close of a window), so any call back into gpuix from it fails with "A renderer call cannot be nested inside another one made from an event handler"; touch only your view. If the handler throws, the error is reported like any handler's and the surface is taken down anyway.

`onAttach` has the same restriction: it runs inside the frame, which holds the window and the app, so any call back into gpuix from it fails with the same nested-call error, and the state it writes in Solid or React is a later batch, not part of this frame. Touch only your view: add it to the content view and give it `autoresizingMask` width and height sizable, which is what makes it fill the container whatever size the frame places it at. If the handler throws, the error is reported like any handler's and the surface stays (and `onDetach` follows, as for any `onAttach` that ran).

If the page unmounts the element before its first frame, `onAttach` is never called and neither is `onDetach`. If `onDetach` is the only handler, it is called for every detach.

Where native cannot call JS from inside a frame (a platform or a test path with no synchronous handler), `attach` goes through the ordinary event queue instead, after the frame, and a teardown can overtake it: the adapters drop such an `attach` and call no `onDetach`. On macOS GPUI runs on the JS thread and draws from `tick()`, a call from JS, so a frame always delivers `attach` synchronously.

### Why `onAttach` runs inside the frame

A frame that adds a native view must show the view and the GPUI content above it together, or the window shows a glass sheet with no text on it, or text with no glass behind it, for a frame. `draw_composed` already presents the frame's drawables **with the Core Animation transaction** the views change in when a view moved, was created or reordered (`MacNativeSurface::apply` reports a first placement as a change). That only helps if the library's view is added in the same turn of the run loop, before the frame presents: an `onAttach` queued behind the frame adds the view one turn later, in a transaction of its own, so the view (or what the page shows in reaction to it) is a frame late. Delivering `attach` in the prepaint of the frame that makes the surface puts the library's `addSubview:` in the frame's transaction. The container stays hidden until `draw_composed` places it, so a library that adds its view in an earlier turn than the present is not seen early either.

A page that waits for `onAttach` to show its children (state set in the handler) shows them one frame after the view, since that write is a later batch. To show view and children in the same frame, render the children from the first frame.

### A minimal library

The library side is a napi addon whose only gpuix-shaped input is a `bigint`:

```rust
// Cargo.toml: napi, napi-derive, objc = "0.2". No gpui, no gpuix.
use napi::bindgen_prelude::BigInt;
use napi_derive::napi;
use objc::{class, msg_send, runtime::Object, sel, sel_impl};

struct Added(*mut Object);
static mut ADDED: Option<Added> = None; // a real library keeps one per handle

#[napi]
pub fn attach(content: BigInt) {
    let (_, pointer, _) = content.get_u64();
    unsafe {
        let content = pointer as usize as *mut Object;
        let view: *mut Object = msg_send![class!(NSView), alloc];
        let frame: [[f64; 2]; 2] = msg_send![content, bounds];
        let view: *mut Object = msg_send![view, initWithFrame: frame];
        let _: () = msg_send![view, setAutoresizingMask: 18u64]; // width and height sizable
        let _: () = msg_send![content, addSubview: view];
        let _: () = msg_send![view, release]; // the content view owns it now
        ADDED = Some(Added(view));
    }
}

#[napi]
pub fn detach() {
    unsafe {
        if let Some(added) = (*std::ptr::addr_of_mut!(ADDED)).take() {
            let _: () = msg_send![added.0, removeFromSuperview];
        }
    }
}
```

Two points a library gets wrong first: the view must fill the content view (`autoresizingMask` width and height sizable; gpuix sizes the content view to the element's padding box), and it must be removed in `onDetach`, because the view would otherwise outlive the surface it was added to.

A library whose view must claim or decline pointer events implements `hitTest:` on it (see [Pointer](#pointer)); one that takes the keyboard makes its view first responder itself (see [Focus](#focus-and-the-keyboard)).

## The element

`nativeview` is a host type (`text::inline::is_host_type`): every pass that treats a `div` one way (inline text planning, paint ranks and `zIndex`, stacking, culling, accessibility, focus order, search, `content-visibility`) treats it the same. A custom element with children is built child by child with none of that, which is why this is not one. What the element adds, in `custom_elements/nativeview/`:

- **The layer.** `build_host_container` inserts, as the first child of the box, a canvas that paints the placeholder (`nativeview::layer`). It is `position: absolute` in gpui's sense (relative to its parent, the padding box; gpuix's CSS `absolute` is a different `Position`) with all four insets 0, so it takes no room in flex, grid or content-sized layouts, and it is `unlifted`: a positioned child would otherwise paint above its in-flow siblings. The box paints its background and border, then the canvas (which splits the frame there, as in [webview.md](webview.md#the-placeholder-and-the-layers)), then its other children.
- **The state.** The registry holds a `NativeviewElement` per element (`nativeEvents`, the surface, the lifecycle), since a host container has none. The surface is made when the canvas is first prepainted, because it needs the window; it is sized to the padding box there (`Window::size_native_surface`), and `attach` is told there.
- **`display: inline`** is blockified, as for a `flex` container: an inline `<nativeview>` would join a paragraph and get no layer.
- **Retention.** `retain_state` is a constant: what is built is a function of tree, style, props and events. `GPUIX_RETAIN_VERIFY=1` is clean over the tests.
- **Default size.** None: it sizes like a `div`, unlike `<webview>`'s 300 x 150.

### Geometry

The native view fills the **padding box**: what an `inset: 0` absolutely positioned first child fills. The border stays visible around it (it is painted before the view and the view does not reach it), and `padding` is inside the view: the children are laid out in the content box, over the view. The container view follows the box through scroll, resize, `transform: translate | scale` (the bounding box of the transformed rectangle, as for `<webview>`), and is hidden by `display: none`, `visibility: hidden` and skipped `content-visibility`, with no detach. `opacity` on the element and its ancestors reaches the container layer.

### Clipping

Clipping follows CSS `overflow`, because a `<nativeview>` is a div with children.

- `overflow: visible` (the default): the element's own box and radius do not cut the view. The view may draw outside its box (a glass view's outer shadow and edge highlights), up to the clips of the ancestors. This is `NativeSurfaceOverflow::Visible` in zed: the container's frame is the content mask, not the box.
- `overflow: hidden | clip | scroll | auto` on either axis: the view is cut to the padding box (the element's own clip is in the content mask the canvas is painted under) and to the **inner border radius** (`border-radius` minus the border width per corner) when the four inner corners are the same circle; any other corners leave it square. The radius is a `CAShapeLayer` mask on the container, so it also cuts what the view draws outside its box.
- Ancestor clips always apply, as rectangles. A rounded ancestor clip does not round the view.

A box that lies wholly outside the clip is hidden (it takes no layer), so the shadow of a view whose box is scrolled out of sight does not peek into the clip.

### Layer order

`DrawOrder` decides, as for `<webview>`. Because the view may draw outside its box, the placeholder takes the order of everything painted before it that overlaps where it can draw (its clip), and everything painted after it in that region is above: with no clip around it, everything painted after a visible-overflow `<nativeview>` is above it. That is correct, and costs a layer per view whatever the overlap; an element with `overflow: hidden` keeps the layers to its box.

**Effect groups.** A `<nativeview>` under an ancestor with `opacity < 1` (held or animating), a `filter`, a `mask`, a `clip-path` or an exact clip splits those groups at the view, as in a browser where the opacity of an ancestor applies to the whole subtree: what is painted before the placeholder (the box: background, border, shadows) is one composite below the view, the view takes the product of the opacities of the groups around it, and what is painted after (the children, later siblings) is the same effect applied again, a composite above the view. Several views in a group make a part between each. See [webview.md](webview.md#the-placeholder-and-the-layers) for how the scene does it and for what is not split (`background-clip: text`); what the split does not do (a filter does not reach the view, overlap across it blends twice) is in [deviations.md](deviations.md#nativeview).

### What the box paints

The box paints what a `div` of the same style paints, all of it in the layer under the native view: `backgroundColor` and `backgroundImage`, `border`, `borderRadius`, `outline`, and every `boxShadow` layer. Nothing of it is above the view, and none of it is cut by the element's own `overflow`: as in CSS, `overflow: hidden` clips the content of a box and not its own outer shadow or outline. So a view that fills the padding box covers the background under it (a translucent or glass view shows it through), and the outer shadow and the outline, which lie outside the border box, are visible around the view whatever the view is.

An **inset** shadow is painted inside the padding box, which is where the view is, so the view covers it (a view that is not opaque shows it through). It is painted under the view, not above it: the native layer is one layer and GPUI cannot paint into it. A library that wants an inset effect over its view draws it in its own view, or puts an element with the shadow among the children, which are above the view.

### Pointer

By default the surface takes no pointer events: the container view's `hitTest:` returns `nil`, AppKit goes on to the views below, and GPUI gets the event the ordinary way. `onClick`, hover and the rest on `<nativeview>` and its children work as on a div, whatever the library's view would answer to `hitTest:` (a plain `NSView` returns itself, so a rule of "the view claims what it hits" alone would make every view eat every click).

`nativeEvents` is the library's opt-in. Then a point where GPUI has nothing above the view goes to the library view's own `hitTest:`, the way a page's does in `<webview>`:

- The container asks the content view. A result that is the container or the content view itself (nothing of the library's claimed it) is `nil`, which falls back to GPUI; a view of the library or one of its descendants is the target. A library view that wants to leave a point to GPUI returns `nil` from its `hitTest:`.
- GPUI content above the view (children, popovers painted later) always wins: those are the hitboxes inserted after the placeholder's, which the layer above it claims.
- GPUI sees a press first (hover, `:active`, handlers of the element and its ancestors, outside-click dismissal), then the library view gets it, as for a page. A handler that stops the propagation of `pointerdown` withholds the press from the library view. The wheel over the view is the library view's; a wheel its GPUI layer above declines goes on to it.
- The cursor over the view is the library's (`cursorRects`/`NSCursor` of its view), and the window view's cursor rects leave out the box.
- `pointer-events: none` on the element or an ancestor turns the capture off: the box is not a hit target.

### Focus and the keyboard

The element is not focusable and not a tab stop. The library makes its view first responder itself when it wants keys (`makeFirstResponder:`). While the first responder is inside a native surface the window's key dispatch does not run GPUI's shortcuts (`keyboard_is_native`), as for a page. A press on anything that is not a native container takes the keyboard back: the window view becomes first responder, the same rule as `<webview>`'s "a click on a GPUI element takes the keyboard back". Tab does not reach GPUI from the library view.

### Several native views and nesting

Each `<nativeview>` is its own container in the window (one overlay layer above each), so the layers and hit tests are exact for any number of them, and none can sit inside another's native view.

**Nested native views** (a native view among the layers of a view's own children, for example several glass views that must live in one `NSGlassEffectContainerView` so that they merge) are not in scope, and this design does not block them later. What would have to change: the composition tree (`composition/tree.rs`) is flat, a list of siblings under the window view; it needs a parent link, so that a surface's container is a subview of its parent's content view and is placed and clipped in the parent's coordinates, and `CompositionState::arrange` needs to cut layers per subtree. The element side would need a way to name the parent surface (the nearest `<nativeview>` ancestor already knows its `Shared`), and the library would be handed a group handle it adds several views to. Nothing of the boundary (the pointer, `onAttach`, `onDetach`) changes.

## Tests

- **zed `gpui`** `composition/tests.rs` (`cargo test -p gpui --lib --features test-support composition`): a surface is sized in the prepaint before its first frame, a surface that overflows its box is cut by the content mask only, a surface wholly outside the mask takes no order, `captures_pointer` and the hit area, translated replay, the order of an overflowing surface. **zed `gpui_macos`** lib (the cursor hole) and `tests/native_surface_present.rs` (a real window that is never shown): the content view has the box's size in the prepaint that makes the surface and a view the embedder adds there follows it, the frame that creates or resizes a view is presented with the transaction and a frame that changes none is not, a window without native views draws no composed frame; `tests/native_surface.rs` (a real window): the default container is not hit, a capturing one hits the library's view and maps itself and the content view to `nil`, a view that returns `nil` falls to GPUI, a GPUI press takes the keyboard back.
- **gpuix Rust** (`cargo test --lib`, `custom_elements/nativeview/`): `geometry.rs` (inner radius, the `captures_pointer` rule), `lifecycle.rs` (attach once, detach only after attach and once, warn once), `tests.rs` (on the test platform: padding-box geometry, layout identical to a `div`, layer order, clip variants, pointer capture, `attach` told in the draw that makes the surface and before any frame is presented, with the content view at the box's size, attach and detach on destroy, subtree destroy and window removal, hide and show, keyed reorder, an unsupported platform, retention parity with a `div`), `events/sync_dispatch.rs` (`emit_without_window`).
- **gpuix vitest** `packages/react/src/__tests__/nativeview.test.tsx` and `packages/solid/src/__tests__/nativeview.test.tsx`, `packages/native/js/__tests__/nativeview.test.ts`: the props that reach native, the handlers (a bigint, once; attach inside the frame that makes the surface, with a content view of the box's size; a renderer call from it fails as nested and the surface stays; detach synchronous during the unmount commit; a queued attach that a detach overtakes, with no sync handler), replacement and removal of handlers, `display: none` and keyed reorders, a throwing handler, an unsupported platform (one warning). The test renderer reads `getNativeviewSurface(id)`, `getNativeSurfaceEvents()`, `getNativeviewWarnings(id)` and simulates a platform that cannot compose with `setNativeSurfacesAvailable(false)`.
- **gpuix vitest** `packages/react/src/__tests__/nativeview-box.test.tsx`: the pixels of each decoration of the box (shadows, background, border, outline, radius, a shadow with the element's own `overflow: hidden`, a style change after attach) equal those of a `div`, and the layers each is in (an inset shadow is under the view, a child above it).
- **zed `gpui`** `scene/split_tests.rs` (`cargo test -p gpui --lib --features test-support split_tests`): the split of a group at a surface (parts, orders, ids, nested opacities, a filter group, backdrop on the first part only, reserved groups, layers, two surfaces, a group with no surface unchanged, nothing split for a text mask, a surface cut away, a hidden scene or a faded-out group), and replay, translated replay and patch rebuild making the same split scene; `composition/tests.rs` has the layer cut of a fading group.
- **gpuix vitest** `packages/react/src/__tests__/nativeview-group.test.tsx`: under a held, animating, nested, filter, `clip-path` or `mask` ancestor the children are in the layer above the native layer and the view takes the product of the opacities.
- **The e2e** in `packages/native/examples/nativeview-e2e/`: a real window and a separate test addon (`addon/`, its own crate: napi and the Objective-C runtime only) that makes a plain coloured `NSView` from the pointer. `sh check-no-gpui.sh` prints `cargo tree` and `otool -L` of the addon and fails if gpui, gpuix or zed appear in either. How to run it: [testing.md](testing.md#the-nativeview-e2e).

## Breaking changes

None. `<nativeview>` is new. `NativeSurfaceStyle` in zed gained two fields (`overflow`, `captures_pointer`); `<webview>` passes `Clip` and `true` and behaves as before, except that a press on GPUI content now takes the keyboard back from a page that held it.
