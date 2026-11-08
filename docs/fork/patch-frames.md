# Patch frames and dormant animations

A running animation should cost what it paints, not what the page holds. A *tick* is a frame whose only cause is the clock. When
everything that changed in a tick is how some elements paint, gpuix builds only those elements and gpui paints them again in the
frame already shown (a *patch*). When the animation is on content nobody sees, nothing is built or drawn (*dormant*). This file covers
both, the cases that used to defeat them, and what a patched tick still walks. How the next tick is asked for, and the display-link
pump behind it, is in [frames-and-wakes.md](frames-and-wakes.md#how-js-is-woken-patch-2). The retention layers a patch builds on are in
[retention.md](retention.md).

## A tick that costs the page (#62)

One colour loop on one text, with nothing else changing, cost a tick 0.94 ms on 500 nodes, 5.84 ms on 3000, 30.5 ms on 12000 and
85.8 ms on 30000, though the tick built 2 elements and painted 8 primitives. The same page drawn once with nothing changed (a forced
draw) took 49.2 ms at 30000.

A draw builds a new `Frame`, and everything a frame holds is copied into it once for each retained root it replays: scene
operations, hitboxes, dispatch nodes, element states, line layouts, accessibility nodes, and in gpuix what the tape republishes. The
profile at 30000 nodes was the bookkeeping of replaying 6000 roots: the element-state map and the id compares about 45%, moving
`RetainedState` 17%, the dispatch tree 7%, gpuix's `retained_root` closure and the bounds and text registries 9%. Layout was constant
and scene and paint were under 1%. A cheaper replay is still a step per root, so the page would still pay for what did not change.

So a tick whose only change is how some animations paint is drawn as Chrome repaints the display items that were damaged: the frame
that is shown is kept, the units that moved are built alone and painted again in it.

| nodes | tick drawn whole | tick patched | patching off |
|---|---|---|---|
| 500 | 0.94 ms | 0.22 ms | - |
| 3000 | 5.84 ms | 0.23 ms | 2.51 ms |
| 12000 | 30.5 ms | 0.22 ms | - |
| 30000 | 85.8 ms | 0.24 ms | 36.0 ms |

Test renderer, release addon built without LTO, 60 ticks 16 ms apart, `clockAdvance` between ticks. "Patching off" is the same page
with the cheaper replay of [retention.md](retention.md) and every tick drawn whole. A patched tick builds 1 element, prepaints and
paints 7, paints 8 primitives and replays no root, at every size; drawn whole it built 2, prepainted and painted 15, replayed 100
to 6000 roots and 800 primitives. The forced draw of the 30000 node page that changed nothing went from 49.2 ms to 3.75 ms with the
cheaper replay. An svg stroke dash loop like a button spinner costs 0.079 and 0.099 ms a tick at 500 and 5000 nodes (0.98 and 13.2
with patching off). In a live window with the display link (75 Hz, 8 s at 3000, 12000 and 30000 nodes) every tick after the first
full frame was patched and cost 0.6 to 1.0 ms at every size.

## Units

A subtree that only a running paint-only animation changes is built whole as a *unit*, so that a tick can build it alone.

**What may run on a unit: paint only.** Every running animation can say whether it only changes what its element paints:
`CssAnimations::paints_only` (every property its keyframes animate is in `AnimProp::paints_only`, an SVG attribute counts, and a name
whose keyframes are undefined or were redefined since the run read them does not), `CssTransitions::paints_only`,
`MotionState::paints_only` (its tracks that can move: one of a layout property that rests at `now` counts for nothing, one that is moving, waiting for a measurement or following layout counts) and `MotionValueStore::binding_paints_only`. Dormancy
([below](#dormant-animations-63)) uses the same classification. An animation of a layout property (`width`, an inset, a `layout`
FLIP animation, a motion value that drives a size) is never paint-only: it is built every tick with the spine above it, culled or
shown, and counted as `LayoutAnimation` in `getPatchCounters().unpatchable`. A binding of such a value that rests does not make a
tick of a loop elsewhere whole.

**Which elements become units** (gpuix, `retain.rs`). `Retain::begin_unit` decides at `enter` from the record of the build before:
everything that runs on the element paints only (`Record::paints_only`, noted by `runs_paint_only`), it is eligible, not dormant,
built in a plain context, holds at most `UNIT_MAX_ELEMENTS` (256) elements, and nothing inside it is skipped (`Kept::InUnit`).
`Retain::end_unit` confirms from the build: no exclusion, no scroller, no absolute descendant placed against a block outside it (the
root itself may be absolute: its own containing block is outside by definition), not absent, and nothing lifted out of it unless the
element is a stacking context that takes it in (an effect group, a positioned element with a `z-index`). An element over the cap is
built whole and counted (`unitsOversized`, `TooLarge`). An element that is no unit says why in `Record::refusal` (`Retain::refusal`),
which the preview turns into the `unpatchable` key. The outermost such element on a path is wrapped as
`gpui::retained(id, key of this frame, prebuilt).patchable()`, with `.lift_z(z)` when it is lifted (`unit_root`) and the `Taped` and
`on_replay_translated` wiring of a `retained_root`, and keeps its `FrameEnv` in `Retain::units()`. A layout-only pass and a deferred
build make none; the reference pass of a verified frame does, since after a patch that pass is the frame shown. A unit root keeps the
start of its build (`BuildStart`, one `Inherited` clone) for a patch to build from again, so the bound of the one-animating-node test
`motion-opacity` is `elementsBuilt + retainableRoots + unitsBuilt`.

**A lifted element can be a unit.** Below 1 an opacity makes an effect group, which gpuix lifts at z 0 into the context around it,
and a positioned element is lifted at its z-index, so a skeleton pulse, an opacity loop and the colour loop of a positioned box are
units. gpui patches such a unit when the new element is lifted as the recording was.

**An `<svg>` whose shapes run a paint-only animation is a unit.** The shapes of an `<svg>` are never built, so the svg host notes
what runs on them (`shapes_running`) as bits of its own, and `runs_paint_only` of the host asks every shape below it. A running
document is rasterised in the paint whatever its size ([below](#an-svg-is-culled-like-a-box)), so any `<svg>` is one.

## How gpui patches (`window/patch.rs`)

A frame that draws is a new `Frame` and copies every root it replays, so it costs the page. A tick that changes only how some roots
paint repaints those roots in the frame that is shown and leaves the rest as it is.

- **`retained(..).patchable()`** makes a root leave a `PatchUnit` in a per-frame map keyed by its id when it records and its
  recording is plain: not relocatable, not culled. The unit holds what the replay key lacks of the surroundings: the id stack, text
  styles, rem size, view, content mask, exact clips, offset, opacity, positioned frame, image cache and stacking contexts.
- **`Placement`** says how a root is painted. `InPlace` when no lift is open. `Deferred { paint }` when the root, or an element
  around it, is painted by a stacking context later (a root lifted by `lift_z`, a hole, or prepainted inside a lift that is open, a
  positioned or translucent box around it): the unit keeps a second set of surroundings, captured when the context paints it, and
  the `lift_z` the root declares. A patch prepaints the new element directly, so it is not lifted again. A root that says it is
  lifted under a parent that lifts nothing is painted in place and patched as one.
- **An absolute root is a unit, recorded and never skipped.** Its node is rewritten against a block outside it by
  `settle_containing_blocks`, which a frame that skips the subtree does not run, so gpui keeps such a recording as a source for a
  patch only (`Recorded::root_escapes`; every frame builds the root). `Window::root_escape` names the root's layout node while its
  recording or patch is made, so its own escapes do not count against it under a clip smaller than its block. The patch runs no
  layout pass; a moved block is caught by the bounds key. `end_unit` judges only what is below the root for an escape, so an absolute
  box inside it against the root is fine and an absolute descendant whose containing block is outside the unit still refuses it as
  `Escapes`.
- **A relocatable root is patched where it was recorded.** A root recorded to be put elsewhere (`retained(..).relocatable(overscan)`,
  a row of a virtual list) is `patchable()` like any other, and keeps its `PatchUnit` while its recording is plain but for the scene
  of its own (`PaintRecord::is_plain_or_relocated`: nothing handed to a stacking context). The unit is registered in the frame that
  records the root and in a frame that replays it with the key it was recorded with (`delta` zero and the key equal, not merely a
  place the recording fits); a frame that replays it elsewhere (a list scrolled since) notes it as *relocated* instead
  (`Frame::relocated`), and a patch of it declines as `PatchDecline::Relocated`, where a root that was never patchable is
  `UnknownUnit`. `Window::patch_blocker` answers the same question without painting, for an embedder that would build the root for
  nothing. The scratch frame paints the root under the content mask captured when it was recorded, which is what a recording at its
  own place was cut by, so what it writes over the frame is what a replay would have put there. A patch of such a root makes the
  recordings of the rows stale for the scroll translate, which puts rows where their recordings paint them: until a frame is built
  whole (`PatchWindow::recordings_stale`) the classifier answers `Other`.
- **`Window::request_tick`** asks for a draw with no view queued and no layout invalidated. A draw for a tick first asks the hook of
  `Window::set_frame_patcher`, which builds the roots the tick changes and calls `Window::repaint_in_place(units, cx, accept)`. That
  restores the surroundings of each unit, lays the new element out onto the nodes the recording has (the counters of a build that
  is skipped must not move), prepaints and paints it into a scratch frame with the recorded hitbox ids handed out in order, and
  compares the result with the recording: the replay key, hitboxes by value, cursors, tab stops, listener, input handler, tooltip and
  dispatch node counts, and the kinds of the operations. Then `accept` runs (the embedder compares its tape). On success the
  operations that paint differently are written over the rendered scene's, and the frame is presented only if an operation
  changed. A tick that changes no operation presents nothing. The scene's primitives are then either written in place or made
  again, see [the next item](#what-a-patch-does-to-the-scene).
- **What a patch does to the scene.** A scene holds its operations in a log and its primitives in typed vectors, sorted by draw
  order. A patch changes how operations paint, seldom where, so most patches have the same draw orders as the frame they patch.
  `Scene::patch_in_place` writes a changed operation's primitive over its slot in the typed vector, with the order it had (a
  path keeps its id too), and touches nothing else: no replay of the log and no sort, which cost the page (several million
  instructions for a 2700 operation frame) whatever the number of operations that changed. It does so when it can prove the slot
  is the right one: the scene has a map from the index of each operation to its primitive's place in the sorted vectors
  (`op_slots`), and every changed operation has the kind and the clipped bounds of the one it replaces, which is what its draw
  order depends on (an order is one more than the greatest of the earlier bounds that intersect). A sprite also keeps its sort
  position: a new atlas texture sorts among the sprites of its order, so one whose texture moved it past a neighbour is not in place.
  Anything else (a kind that changed, a primitive that is clipped away now or was, bounds that moved, an operation that is not a
  primitive, one inside an effect group or a text clip or faded flat, or a quad drawn as strips around its empty interior, none of
  which is one primitive of the root's vectors) makes the scene again with `Scene::rebuild_from_operations`, the way every patch
  did, reusing the draw orders of the log when the bounds sequence is the same. The map is worked out by that rebuild, as it
  sorts (the gather permutation of `Scene::finish`, see [the sort](syncing-upstream.md#scenefinish-sort-order-and-permutation-zed-sceners-platformrs)), and a frame built whole or one a scroll translate
  rebuilds has none: the first patch after such a frame makes the scene again and the ticks after it write in place. The
  retention verifier makes the map ahead of a patch and compares the scene a patch wrote with the frame built whole after it.
  `PatchCounters::scene_rebuilds` counts the patches that made the scene again and `in_place_primitives` the primitives written.
- **Any failure declines.** The element states go back, the layout pass ends, and gpui draws the tick whole in the same draw.
  `PatchDecline` names the reason: pending view, refresh, unknown unit, stale recording, surroundings, layout mismatch, unstable
  layout, effects, relocated, hitboxes, registrations, operations, lifts, scroll extent (the transforms that ticked would clamp a scroller's offset or move a thumb), rejected. A wrong patch is a mismatch under the verifier.
- **Counters.** `Window::patch_counters` reports patched frames, patched units and the declines by reason; `frame_work_counters` also counts the elements and primitives a patch painted, and `rasterized_glyphs`, the glyphs rasterized because the atlas missed them: a glyph of a patchable root that the content mask clips away is a pending glyph operation (compared like a sprite, never rasterized until it shows), so a patched tick of a long text behind a clip rasterizes only what shows.
- **A unit that holds the focused element is patched.** The scratch frame sets `Frame::focus`, which used to fail the registration
  check for every such unit; the unit is declined only when it gains or loses the focus.

## The gpuix patcher (`retain/patch.rs`)

Installed once per window from `render`. For a tick it takes `now` from the clock and asks `Retain::preview`, which changes nothing.
A tick is patchable when, since the last frame built whole: only time-driven ids changed (running `dynamic`, motion that runs or
ended, not yet built), each in a unit or dormant; the root revision is the same; no layout-only pass ran; no scroll animation runs;
no scrollbar is fading or thickening (`scrollbar::needs_frames`) or was painted at an alpha or thickness that the clock has since
changed, which is what the end of its hold is (`scrollbar::stale_at(now)`: the hold itself is steady, so a tick in it is patched);
no `layout` box has a glide in flight or events to send (`LayoutFlips::needs_frames`, asked of the live
flips and not recorded); and that frame built no element that follows the clock (`Exclusion::varies_with_time`). An element with no
box (`display: none` or below one, `box_generation::is_hidden`) is skipped as a dormant one is.

The reasons it says no are `Unpatchable`:

| Key | Meaning |
|---|---|
| `NoFrame`, `LayoutPass`, `Unsteady`, `Gliding`, `ScrollAnimation`, `Edited`, `Everything` | no frame to patch, a layout-only pass ran, the last frame held an element that follows the clock, a `layout` glide is in flight or its events are to be sent, a scroll animation runs, a scrollbar fades or thickens or its hold has ended since it was painted, the tree was edited by something other than a restyle a patch follows (`RetainedTree::patch_barrier` is newer than the frame), everything changed |
| `Sourced` | the pointer, focus, a scroll, a custom element, a measurement, a link or a command changed |
| `Outside` | a time-driven change outside every unit that is not dormant, on an element that has a box and the last build gives no reason for |
| `Refused` | the element is no unit: `Excluded:<kind>` (`Excluded:fixed` for `position: fixed`; gpui has no root placed by the viewport, `Escape::Viewport` is declined `Surroundings`), `ExcludedBelow:<kind>`, `Escapes`, `Lifts`, `Scrolls`, `LayoutAnimation`, `TooLarge`. What runs on the element is looked at first, so an absolute element whose `top` runs is `LayoutAnimation`, and so is a tick made `Sourced` by the measurement of a layout animation |
| `Ended` | a unit whose element the last frame no longer found a paint-only animation running on, though a source still lists it, as an SVG shape that holds its end value is: a frame built whole would not make it a unit, so it is not repainted as one |
| `Hover` | a hover restyled by paint an element that no unit or patch root of the last frame built whole holds ([patch roots](#patch-roots)): the frame is built whole, and visits the roots the next hover is patched in |
| `Commit` | a commit restyled by paint an element that no unit or patch root of the last frame built whole holds ([commit patches](#commit-patches)), as `Hover` does for a hover |
| `Dormancy` | the preview has no unit but elements are about to enter the dormant set or their verdicts moved: the frame settles that ([skipped content](#skipped-content-97)) |

If it says yes, the patcher steps what a frame steps before it builds (`sync_motion_states`, `sync_motion_values`, the clocks of the
dormant animations, their events) and builds each unit with `GpuixView::build_unit` from its kept env at `now`, with the retention
closed (nothing entered, recorded or tapped, `BUILD_EFFECTS` truncated, events drained, `built_at` set, no frame asked for), inside a
tape that captures: `Tape::capturing` notes the writes of a prepaint and paint without making them. gpui's `accept` is
`Tapes::same_as_recorded` for each scratch tape. On success it takes the active flags and asks for the next tick; on any decline it
returns false and gpui draws the tick whole in the same draw.

A tick declines safely: the clocks were sampled at an instant and not stepped, so the frame that follows finds the state it would
have, and each event was emitted once. The frame that ends a build asks for the next one with `request_next_frame`:
`on_next_frame(request_tick)` when units were made (`Retain::has_units`) and patching is on, `request_animation_frame` otherwise or
while a scroll animation runs. `patches_ticks` does not need a unit, so a page with none asks for ticks and counts them. Patching is
off with the retention, and with `GPUIX_PATCH_OFF` or `setPatchEnabled(false)`. The counters are listed in
[testing.md](testing.md#switches-and-counters).

The clock, a hover that only paints (see [Hover patches](#hover-patches)) and a commit that only paints (see [Commit
patches](#commit-patches)) are what a patch can answer. A hover that does more than paint, a commit that does more, a scroll, a
measurement or a click draws a full frame, and patching resumes at the next tick.

## Cases that used to draw whole

Each of these made every tick of a loop elsewhere on the page a full frame. Found with `getPatchCounters().unpatchable` and
`declines`, `getBuildCounters` and `getFrameWorkCounters`.

### An opacity run is a compositor layer from its start to its end (#81)

A loop on `opacity` used to be lifted into an effect group only below 1, and painted nothing at 0 (the scene was hidden). A loop
through exactly 1 or 0 changed the shape of what its element paints: the tick at 1 flipped the lift and declined the patch
(`Surroundings`), and the tick at 0 dropped the operations (`Operations`), so those ticks and the one after were drawn whole. It was
a bug in retention as well: a record made at opacity 1 (not lifted) and skipped (a dormant loop below the window) was handed to gpui
as a wrapper with no lift, and the build that replaced the replay when the card came into view was lifted at 0.25. zed's
`retained.rs` `request_subtree_layout` ("the root of a retained subtree is lifted as its element says") panicked on a debug addon,
and the release addon kept the stale `None` and painted the element in the wrong place of the stacking context.

In Web Animations an element with a current animation of a property acts as `will-change` of it, and Chrome keeps its compositor
layer. So an element whose `opacity` is animated is an effect group for the whole run, at whatever value it samples.

- **gpuix** (`animate_style`): `StyleDesc::animating_opacity` is set while a CSS animation that is current (active, or before its
  active phase going forward, not one that only fills), a running CSS transition, a `motion` track or a moving motion value targets
  `opacity` (`opacity_runs`). `has_effect_group` reads it, so `lift_z`, `creates_context` and `Resolved` all see an effect group at
  any sampled value.
- **zed**: `Style::has_active_opacity_animation` makes `group_effect` return a group at 1 and keeps the element's scene at 0, so the
  operations keep their shape from one tick to the next. A static opacity is as it was: 1 has no group, 0 paints nothing.
- **A run's start and end are whole frames**, as Chrome re-layers there. `Record::lift_run` says whether a build was in a run, and
  `skippable` refuses a record that disagrees with the run state now (`Kept::LiftRun`), so the wrapper of a skipped root never
  carries a lift that the build replacing it does not. Don't weaken that check: the panic above returns. A state style that changes
  the opacity (`hover`, `focus`, `focusWithin`, `groupHover`, `hasHover`) or a write changes the element's record, so it falls under
  the same rule with or without a transition. `lift_run` is also true while any run of a transform property is current, Motion's included
  ([paint-and-transforms.md](paint-and-transforms.md#retention-and-patched-ticks)).

The ticks inside a run, at 1 and at 0 included, are patched. A native loop and a CSS animation through exactly 1 and exactly 0, at
500 and 5000 nodes, patch at every tick, and nothing is declined or counted unpatchable.

### An `<input>` is retained and its caret is a tick (#74)

A page with an `<input>` or `<textarea>`, focused or not, in view or not, drew every tick of a loop elsewhere whole (`Unsteady`
at the tick rate): 4.0 ms a draw at 7.8k elements, 7.4 ms at 13k. A page with a `<code>`, `<markdown>` or `<diff>` did the same.
The input had no `retain_state`, so it was `Exclusion::CustomElement`, which was in `varies_with_time`, and `Plan::unsteady`
declined every tick of a page that built one. The kind was listed for the input, whose caret follows the clock; `<code>`,
`<markdown>` and `<diff>` have no `retain_state` either but do not follow it (the highlight is made on the frame thread and nothing
of them arrives late). The input's measure was a keyless request, which made every recording of it `UnstableLayout`.

- **The editor is retained like any element.** `TextEditorElement::retain_state` is an epoch (`TextEditorState::changed` counts
  every notify of the editor but the blink's), so what is typed, selected or scrolled rebuilds the input and nothing else does;
  focus and the window going key are already in the planner's focus bits. Its measure is keyed (`request_keyed_measured_layout`,
  `TextEditorState::measure_key`: the shaped text, runs, sizes, rows, the font generation and the entity).
  `TextSystem::font_generation` is public in zed for the key.
- **The caret is the clock's only.** `CustomElement::follows_clock` notes `Dynamic::Blink`, an own, paint-only kind, so a focused
  input is a unit unless a layout animation also runs on it. The blink is a timer aimed at the end of the phase (`arm_blink`, from
  the activity anchor on the executor's clock, not a 500 ms loop) that calls `Window::request_tick` instead of notifying, and the
  caret quad is painted in both phases (in no colour while off) so a patch has the operations of the recording. An unfocused input,
  or one in a window that is not key, has no source at all.
- **A tick of another loop does not build the input.** `CustomElement::clock_due` says whether what follows the clock changed since
  it was painted: the phase's timer sets it and the paint clears it. `Retain::between_changes` leaves an element whose only dynamic
  is `Blink` out of the touched set while it is not due.
- **A caret nobody sees asks for no frame.** The timer is armed by the prepaint of the editor (`TextEditorState::keep_blinking`),
  only while the window is key, the caret is shown and its box meets the content mask and the bounds of the editor; `render` only
  notes the focus coming. An input scrolled back into view arms again in the frame that moves it.
- **`<code>`, `<markdown>` and `<diff>` left `varies_with_time`.** Nothing else read it for custom elements.
- **A virtual list and its rows left `varies_with_time` too (r52).** A `<virtual-list>` beside the input (the search box of a mail client) made the frame before it unsteady, so every blink was a whole frame that rebuilt the visible rows (2.4 ms in a `sample` profile). A list is painted as the frame that built it left it: its rows are measured in that frame, and a scroll, a new window of rows or an animation in a row is a source of its own (an animation in a row is `Outside`, since no unit holds it). Test: `animation-frame-work` "blinks in patched frames that build the input alone beside a virtual list".
- **A list that was scrolled, and a row under the pointer (r53).** A scroll asked for a frame at every vsync of the scrollbar's hold and fade, which queued the view dirty and made gpui decline every blink (`PendingView`); the hold asks for none now ([scroll.md](scroll.md#scrollbars)). A row the pointer was over was `Outside` at every tick: the hover that changed it put the row on the spine of the frame, and no build ever enters a row (the list builds them in its layout, whatever the window holds), so it stayed in `unbuilt` for good. `RetainedElement::is_built_by_ancestor` is true below a `<virtual-list>`, so a row is not kept there. A row is entered now, in a session of its own ([retention.md](retention.md#rows-of-a-virtual-list)) outside the walk of the frame, and the spine still reaches it: it is built because the hover changed it. Tests: `animation-frame-work` "blinks in patched frames that build the input alone beside a virtual list scrolled by a wheel / scrollTo, while the scrollbar holds / after the scrollbar has faded"; `retain.rs` `a_changed_row_of_a_virtual_list_is_not_left_unbuilt`.

A loop beside a focused or unfocused `input`, a `textarea` or an input out of the clip went from 4.0 ms and 27.5% of a core
(`Unsteady` 67.5 a second) to 0.8 to 0.95 ms and 6% at 7.8k elements, the same as the page without an input (0.97 in the same run),
with every tick patched. At 13k elements 7.4 to 0.34 ms; at 1306, 1.16 to 0.34 ms. The blink is a patched frame that builds the input
alone.

### A loop under a positioned or translucent ancestor, or on an absolute element (#75)

A colour or stroke loop on a text or an `<svg>` under a `position: relative`, `absolute` or `opacity < 1` wrapper drew every tick
whole (`UnknownUnit` at the tick rate), and so did a loop on an element that is itself `position: absolute`: 3.1 to 3.9 ms a draw at
7.8k elements, 5.3 to 6 ms at 13k. The cause was in gpui. `capture_patch_unit` recorded a unit only for a static root with no lift
open, and for a lifted root with exactly one open lift in a lifting context, so a root prepainted inside any open lift (gpuix lifts a
positioned box or an opacity group, `lifts_open >= 1` while it is prepainted) recorded nothing, and `try_repaint_in_place` declined
it. For the element that is itself absolute, gpuix refused it as `Escapes`, since gpui kept no root placed by a box outside it. The
fix is `Placement` and `Recorded::root_escapes` above.

Draw ms at 3000 nodes (7805 elements, release addon), before to after: text under `relative` 3.29 to 0.36, under `absolute` 3.10 to
0.40, under `opacity < 1` 3.22 to 0.40, itself `absolute` 4.36 to 0.38; `<svg>` under `relative` 3.44 to 0.23, under `absolute`
3.85 to 0.23. The absolute text was 30% of a core and is 3%. At 5000 nodes (13005 elements) a text under `relative` and one that is
itself `absolute` went from 5.28 to 0.34 ms. A page with a `relative` header wrapper: a colour loop 3.45 to 0.67 ms at 500 nodes,
2.59 to 0.41 at 2000 and 8.89 to 0.43 at 8000 (64% of a core to 3%); the stroke loops likewise. Every tick is patched and `declines`
is empty. A `width` or `top` loop there is still drawn whole, and now says `LayoutAnimation` at the tick rate where it said nothing.

### A motion value is touched when it can have changed (#76)

A motion value bound to a box drew whole for four reasons (a visible paint-only binding already patched; an `<svg>` stroke is reached
through the `color` of the `<svg>` and `currentColor` strokes, since a motion value binds to a style property and never to an
attribute of a shape):

- A box bound to a value that rests was built by every tick of a loop beside it (50 resting boxes: 51 elements built a tick, 1 alone).
- A width, left or top bound to a value that rests made every tick of a loop elsewhere whole (`LayoutAnimation`, 8 of 8).
- A paint-only value bound to a culled element requested a frame every vsync, drawn whole (`NoUnits`, 764 primitives replayed),
  where a CSS loop there asks for none.
- A script's `mv.set(v)` from a `requestAnimationFrame` loop, or from the `change` of another value, was a whole frame at each
  write (`PendingView`).

Every element with a `motionValues` binding carries `Dynamic::MotionValues`, and `Retain::preview` touched all of them at every tick,
moving or resting. The end of a frame asked for a tick whenever any bound value moved (`MotionValueFrame::active`, one tree-wide
bool), which never reached the dormant branch. A write went through `Repaint::MotionWrite` to `notify_paint_only`, which queues the
view.

- **A resting binding is not touched.** `MotionValueStore::binding_due` says whether a binding can show otherwise than the frame
  that built its element did: a value it binds was moving by itself when that frame sampled it (`frame_moving`), or it, or a value
  it is computed from through transforms and followers (`MotionValues::follows_any`), was set, jumped, animated, stopped or
  controlled since (`written`, cleared by `frame`, which a frame built whole and the patcher's `step_clocks` both run). It goes
  through `Sources::clock_due` beside the caret's, and `Retain::between_changes` leaves an element whose only dynamic is `Blink` or
  `MotionValues` out of the touched set while it is not due. One that also runs an animation is touched by every tick.
- **What the values ask of the frames is per element.** `MotionValueStore::demand` is `Frame` when a value bound by an element that
  is not dormant (or read by a drag) moves, `Dormant` when only dormant elements bind it or only a listener reads it, `Idle`
  otherwise. `Dormant` arms the dormant tick when a listener needs one ([wake times](#wake-times-90)).
- **A paint-only write is a tick.** `Repaint::invalidate` asks for one (`Window::request_tick`) when `GpuixView::patches_ticks` and
  `MotionValueStore::writes_paint_only` hold; `animate`, `stop` and the controls take the same road, so the frame that starts and
  the frame that ends a run are patches too. The layout stays current, so a read of bounds before the frame lays nothing out. A
  write that can move a box still invalidates layout and is drawn whole, and with `GPUIX_PATCH_OFF` it notifies as before.

Counted, not timed: 50 resting bound boxes beside a colour loop build what the loop builds alone (1 element a tick, from 51); a loop
beside a resting width, left or top patches every tick; a bound colour, background colour, spring or range transform out of view in
a scroller, or among 5000 nodes below the window, draws no frame in 24 ticks and sends one `change` per tick; a `color` written
every frame at 500 and 5000 nodes is patched at every write with the work of the loop.

### An `<svg>` is culled like a box

Every custom element called `Subtree::block`, so an `<svg>` and everything above it could never be culled, `Dormancy::holds` never
saw it culled, and a stroke loop on a card nobody sees was built every tick. A document over 4096 bytes or 128 x 128 px was
rasterised by a job, which a patched tick would start and then show the image of the tick before, so a running one was
`Exclusion::Svg` and every tick of it was drawn whole. Now:

- **The ink of an `<svg>` is its box.** It draws one image fitted to its box, `overflow: visible` included, so `build_element` takes
  `Subtree::of_element(empty, style)` for it in place of `block` (the box plus what its own style adds) and the element calls
  `cullable`. In a culled subtree its canvas makes no image and starts no job (`SvgPaint::note_culled`; `retain_state` is 1 after
  such a paint, so an `<svg>` never shown is not an unsettled raster).
- **The shapes sleep with it.** A shape is never built, so a running shape used to be named in `Sources::motion`, which `holds`
  could never find culled. `running_motion` names the `<svg>` (`svg_tree::host_of`), and the clocks of its shapes enter and leave
  dormancy with it (`with_shapes`), so `animationiteration`, `animationend` and `getAnimations()` of a shape come at the ticks of a
  shown one.
- **A running document is rasterised in the paint, whatever its size** (`CustomElement::shapes_run`, `Key::in_paint`), so
  `draws_changes_at_once` holds and its ticks are patched. A static large `<svg>` keeps the job. The rasterisation moves from a
  background thread to the frame, which the whole frame it replaces paid in waiting for the job as well.

Per tick, test renderer, release, median of 30, before to after: a 200 x 200 `<svg>` with one running circle 0.53 to 0.11 ms on 500
nodes and 4.30 to 0.12 ms on 5000; 400 x 400 0.73 to 0.29 and 5.85 to 0.28; 400 x 400 with 40 running shapes 4.11 to 3.80 and 7.83
to 3.73; 800 x 800 with 40 shapes 7.36 to 5.94 and 10.97 to 5.91. None was patched before; 39 of 40 ticks are after (the first
records the unit). Below the window or clipped out of a scroller, 200 cards with a stroke loop on an `<svg>` of any size make the
idle tick and the hover frame of 0 cards.

An `<svg>` whose paint would start a job (`Unsettled::Stale`, a document or colour that a paint would start a job for, which a replay
would not) is whole for one frame: its `retain_state` is `None`, so the frame before that paint is unsteady. The job's result arrives
as a frame of its own and the ticks go on after it.

### An `<svg>` waiting for its raster, and motion under `display: none`

A page with a thinking indicator (a text that shimmers and a glyph that morphs its `d`) drew every tick whole (2358 elements, 1240 x
780, 75 Hz, 8 s, release addon: 68 draws a second, none patched, 6.3 ms a draw, 40 to 44% of a core), and the tile of the indicator
alone (47 elements) patched 63 of 68. Turning off either loop alone changed nothing, turning off both drew nothing, so the page held
every tick whole for as long as anything on it ticked. Two things on the page that nothing draws:

- **An `<svg>` that had not painted an image was unsteady.** `SvgElement::retain_state` was `None` (`Exclusion::Svg`, one of the
  kinds that `varies_with_time`, so `plan.unsteady` and `Unpatchable::Unsteady` for every tick) whenever `SvgPaint::paints_in_place`
  was false: before any paint had made an image, while a job ran, with a result in the inbox, and with a big document or a colour
  that the image shown was not. A box with no area (`width: 0`, a big document with `height: 0`) is never painted (`paint_svg`
  returns before `SvgPaint::image`), so its state stayed `None` for as long as it lived and every frame that built the page recorded
  the page as unsteady.
- **Motion under `display: none` was outside every unit.** `Retain::preview` named an element something runs on that no unit holds
  as `Outside`, also when it has no box (`display: none` or below one: no build reaches it and no frame paints it). The closed
  dropdown and the cards that are not shown ran a motion or had been built with a value, so every tick of the page was declined for
  them (`Outside` 64 a second).

The fix:

- **A waiting `<svg>` has a word in its state.** `SvgPaint::unsettled` says which of `Unsettled::{NeverPainted, JobRunning,
  ResultWaiting, Stale}` holds, and `retain_state` gives a word per waiting state (2 never painted, 3 job running, 4 its result
  waiting for the next paint). Nothing a replay of the last paint draws differs while it waits, and the arrival changes the word,
  which `compute_deltas` finds as a changed custom element and builds that `<svg>` once: the arrival draws one frame that is not a
  tick, and ticks go on after it. Only `Stale` stays `None`.
- **An element with no box is not outside a unit.** `Retain::preview` skips it as it skips a dormant one.
- **`getRetainDebug` says why.** `exclusionWhy` names why a built element excluded itself (`CustomElement::unretained_because`; for
  an `<svg>` the `Unsettled` name), and `outside` lists the elements ticks were declined for as outside every unit, with their record,
  their refusal and whether they are hidden or unbuilt (`[d:none]` in their labels).

That page went from 68 whole draws a second (`Outside` 64 a second), 6.1 ms and 42% of a core to 63 of 68 patched (the rest are the
word roll's layout animation, `LayoutAnimation` 4.2 a second, and `Edited` 0.4 a second) at 4.0 to 4.2 ms and 28%. The first draw
that notes a blink after a focus is whole (it cannot also be the unit, counted `Outside`); the blinks after it are patched. The sweep under [what a patched tick still walks](#what-a-patched-tick-still-walks) measured the same page again: across both runs it went from 68 whole frames a second at 6.1 to 6.3 ms and 40 to 44% of a core to 63 patched of 68 at 3.3 to 4.2 ms and 21 to 28%.

### An idle `layout` box (#117)

A looping opacity animation beside a `motion.div` with `layout`, `layout="position"` or `layout="size"` that never moves drew every
tick whole: 0 patched and 150 whole in 150 ticks, against 150 and 0 for the same page without the prop. Two causes, which show as two
reasons:

- **`Unsteady`** (FF's `queued-stack`: 674 in 10 s, 25 to 29% CPU against 9.7%). Every `layout` element built is
  `Exclusion::LayoutAnimation`, and that exclusion was in `varies_with_time`, so the plan the frame recorded was unsteady for as long as
  the box existed, whether or not a glide ran. The glide is not a property of the build: it starts in prepaint, at a frame that finds
  the tree changed and the box moved, and a tick (whose revision is the plan's) can never start one. So a plan no longer carries it.
  `Retain::preview` is told whether a glide is in flight (`LayoutFlips::needs_frames`): a box with a track that has not run out, an
  event not yet sent, or a drag (a `dragOffset` box with the pointer on it, or with one of its values written since the last
  frame sampled them: they reach a box that is not bound to them, and nothing else tells a tick that a drag started, moved or ended;
  see [a `dragOffset` box](#a-dragoffset-box-beside-a-loop)). The tick is then `Gliding` and is drawn whole, which builds the box and steps its track. The frame that steps the glide to its
  end puts `layoutAnimationComplete` in the store, and a render sends it, so the next tick is whole as well (`events` not empty), and the
  one after patches. A box with no box of its own (`display: none`) is stepped by nobody and does not count. A box that glides later
  starts as it always did: the commit that moves it is a tree edit (`Edited`), that whole frame builds it (it is excluded, so it is
  never skipped), and its prepaint starts the glide from where it was shown.
- **`NoFrame`** (the repro: 200 bars of 80 by 4 beside the loop). The excluded box makes every ancestor not eligible to be skipped, so
  the page held no root worth skipping (each bar is a root of one element), the back-off took the page for one that gains nothing from
  being recorded, and recorded one frame in nine: the plan was forgotten between them, and the records with it, which the units
  of the next frame are chosen from (`begin_unit`), so the page never had one. An element a tick could patch (something runs on it
  that only paints, and nothing refuses it) is now a candidate as an element a frame could skip is, so the page is recorded
  (`finish_session`). The pages where this shows are the ones that can skip nothing beside a loop; FF's, with large cards, was
  `Unsteady`.

A box that is itself animated (`layout` and `animate` on one element) is not a unit, as before (`Excluded:layout-animation`), and an
ancestor of a `layout` box is not one either (`ExcludedBelow:layout-animation`); only the neighbours stopped paying.

### A `dragOffset` box beside a loop

A `Reorder.Item` (a `layout` box with `dragOffset`) beside a looping animation drew every tick whole, held or not (150 whole and
0 patched in 150 ticks, 0.80 ms a tick against 0.52 for the same page patched), because `needs_frames` counted every such box as
dragged for as long as it existed. It now asks about the drag itself (`drag_moves`):

- the box was last shown dragged (`Flip::dragged`), or its `active` value read above one half at the last frame that sampled it, or
- a script wrote one of its three values, or a value they follow, since the last frame sampled them (`MotionValueStore::any_written`).
  The press, the moves and the release are all writes, so the tick that follows one is whole and steps the box with the new values;
  the tick after a press that no frame has sampled yet cannot show a stale box.

A box nobody holds asks for nothing, and the loop beside it is patched as on a page without the box (150 of 150). While the box is held
the ticks are whole (the drag is not patched: the box is a translation of its projection, built by every frame, and its values are not
bound to it, so there is no source a tick could carry), 0.69 ms a tick; the release frame is whole, the glide back to the slot is
`Gliding`, and the ticks patch again after its `layoutAnimationComplete` has been sent.

## What a patched tick still walks

A patched tick should cost what its units cost, and one on a page with many motions did not: 4.11 ms on average (median 4.27) against
1.92 (median 1.55) for the tile alone in the same run, where both patch the same units (10.5 built a tick, with 10.5 elements, 69.5
prepainted and painted, 10.5 primitives and 40 layout nodes reused). A sample of the release addon found the rest in three walks
over the page, each in something that did not move.

| Walk | Share of a patched tick | Grows with |
|---|---|---|
| `sync_motion_states` (half of it `parent_inherited` walking each motion's ancestors, the rest comparing each motion's source with its last) and `running_motion` | 26% and 5% | the motions on the page |
| `Scene::rebuild_from_operations` (every primitive of the frame put in the scene's bounds tree again) | 22% (95% with 1000 boxes in view) | the primitives in view |
| `step_clocks` sampling and parsing the bindings of every element that binds a motion value, and `preview` parsing those of every element last built with one (`binding_due`) | 52% with 1000 bound boxes, 18% in `preview` | the bound values on the page |

- **A tick steps the motions that move.** `GpuixView::sync_motions` notes the motions that moved and the `MotionInputs` of what a
  sync reads but the clock: `structure` is a hash of the tree and its revision, appearance, viewport and measurements, beside the
  hover chain, the press chain and the focus-visible element. `step_motions` (a tick) steps only the moving motions while the inputs
  are the same, and all of them when they are not or when a measurement waits for a frame to take it. A motion that moves at a tick
  moved at the one before, since an animation is active from its start (its delay included) until it ends, and only a change of
  what a sync reads starts one. `preview_tick` takes its running motions from the same list. `getBuildCounters().motionsSynced`
  counts the motion elements a sync read.
- **A frame built whole syncs the motions it builds.** `sync_motions_for_build`, called by `render` (whole and layout-only passes),
  does the full sync when `structure` changed. Otherwise it steps what a tick steps, except the moving motions whose element has
  no box in the pass about to be built (under `display: none`, or under a host that skips and that the pass does not force,
  `is_hidden_before_build`), which wait for their wake. Where the build could decide otherwise (a `display` an `@container` folds,
  a skip a read forces) the check says "has a box". A hover, a press or a focus-visible change reaches only the motions whose
  element, or the ancestor that controls their variants, flipped, and syncs those whether they move or not. Hosts a layout-only
  read forces count as built. `build_virtual_child` steps the moving motions of its row and does not sync the page; a gesture
  change in a row's draw is a full sync. A hover over a page of 401 resting motions syncs 1 a frame (2 with a `whileHover`), where
  a whole frame synced all 401.
- **A tick makes its scene again from the draw orders it had.** A draw order is one more than the greatest of those of the bounds
  inserted before it that intersect it, so it is a function of the sequence of bounds a scene took, and a patch changes how
  operations paint, seldom where. A scene keeps the bounds and the order of each insert since `clear` (`order_log`, and the log of
  each group it ended, by the id it has in its build), and `rebuild_from_operations` compares the bounds it inserts with that log:
  while they are the same, in the same sequence, it takes the orders from the log and does not ask the tree (zed
  `Scene::insert_bounds`). A sequence that is not the one reused (something moved, a quad that gained a background and lost its
  strips, a group that faded out) is rebuilt with the tree, after the insert that found it, and the tree a rebuild did not fill is
  made from the log when something is inserted afterwards. `getFrameWorkCounters().boundsInserts` counts the orders worked out with
  a tree. The comparison of what an operation paints with its recording (`PaintOperation::differs_from`) used to format both through
  `Debug` to two strings for every operation of every unit, 8% of a tick of the tile; it formats the recorded one once and writes the
  other through a comparison that stops at the first character that differs, which is early for what changes (a colour, an opacity).
  The answer is the one of comparing the two strings.
- **A tick samples the values that move and parses no binding.** `MotionValueStore::step` samples again what moved by itself when it
  was last sampled (the values elements bind and the ones read for a drag) and the values a write since can have changed, and leaves
  the rest as the frame left them, since only time and a write move a value. A tick does that while the bindings, appearance and
  viewport are the ones the last frame sampled (`GpuixView::step_values`, keyed on the tree and its revision as `step_motions` is),
  and a frame samples them all (`sync_values`). `BindingIndex` holds the bindings parsed once per revision of the tree, by element
  and by value: `value_demand` asks only the elements bound to a value that moves, and `preview` and a frame ask `element_due` of
  it. `getBuildCounters().motionValuesSampled` counts the values sampled for the elements that bind them.

Patched ticks alone: the showcase page went from mean 4.11 to 1.82 ms (median 4.27 to 1.18) against 1.92 (median 1.55) for the tile
alone, so nothing of the page is left in it. At window scale 2, which is what the machine gave for the sweep, the patched tick is 3.05 ms against 3.06 for the tile alone. Over a full sweep at window scale 2 the showcase went from 4.0 to 4.2 ms a draw and 28%
of a core to 3.3 to 3.7 ms and 21 to 22%, and the same page without the shimmer from 2.8 to 3.1 ms and 19 to 20% to 2.0 ms and 13%.
Beside a loop, median per patched tick over 300 ticks: 1000 plain boxes in view 1.87 to 0.125 ms; 1000 resting bound boxes 2.39 to
0.21 ms (none 0.05).

What is left is the cost of the units themselves. A `motion.path` that morphs `d` is a new document every tick: it is parsed again
(usvg `parse_svg`, about 5% of a patched tick of the tile), rasterised in the paint, and the atlas makes a Metal texture for it and
releases the one of the tick before (`PlatformAtlas::get_or_insert_with` and `drop_image`, about 14%, IOGPU calls). The tick is
patched, and costs what the unit does. And what a unit paints is still compared with its tape through strings: the operations stop at
the first differing character, the entries of the tape are still formatted whole (about 14% of a tick of the tile, with the
operations, before the operations changed).

## Dormant animations (#63)

200 cards clipped out of view, each with a colour loop, cost an idle tick 4.86 ms against 0.09 ms for the same page with no loops,
and built 403 elements (0.16 ms with patching and dormancy, against 0.08 ms with none). Chrome paints nothing for them. A hover over a sidebar beside 5000 such cards took 37 to 43 ms against 0.4 to
1.5 ms with none. Two causes: a CSS animation steps only in a build, so every culled animated card was built (2 elements) with the
spine above it each tick, for a result that nothing draws; and a hover frame replays every card of a scroller, at a cost per element
and not per root (about 8 µs for each card nobody sees, 1.2 µs an element, with flat counters; the profile put it in ids that missed
the pointer compare and fell to `SmolStr::eq`, about 30%, the loop that moves nested roots, `Frame::finish` moving the element
states, `reuse_subtree`, and gpuix's tape writing each replayed root into the registries).

Nothing is built or drawn for an animation nobody sees.

- **An element is dormant** when everything that runs on it only changes what it paints and the last frame that reached it walked it
  culled (`ElementBounds::culled`, taken from `Window::is_culling` in the prepaint listener of `capture_layout_box` and written
  through the tape like the rest of the box, so a replayed root republishes it; a verified frame leaves it out of what it compares,
  since a root kept near a scroller's clip is walked culled when it replays an old recording and unculled when it is built whole).
  `Dormancy::holds` decides it from live state: culled, no span, no `layout`, and the animations, transitions, `motion` and
  `motionValues` of the element paint only. An `<svg>` can be culled and so can sleep, with its shapes. `Dynamic::Spliced` keeps the
  children of an animating `display: contents` element out of it. A dormant element is left out of `changed`, so its ancestors leave
  the spine and the root around it replays. A culled recording cannot replay at a place that is not culled (`ReplayKey::culling`),
  so a card that shows again is built late with the clock of that frame, and the colour it shows is the current instant's.
- **A dormant element costs a frame nothing while nothing about it changed.** `Retain::dormant` is a persistent map (element, the
  kinds running on it) kept out of `dynamic`, so `compute_deltas` asks `Dormancy::holds` only of what is not asleep. An element
  sleeps until something can have changed its answer: a build that reaches it (`finish_session` notes it in `woken`, and the next
  frame that begins asks again, so the frame that built it still sees what the frame before found), or what `holds` reads that no
  build of the element tells (`Sources::verdicts`: the keyframes registry's epoch, the tree's count of re-parentings, the viewport),
  which asks every sleeper again. A frame that does not record (retention off or resting, planning off) lets them all go, and a
  destroyed element is let go by `prune`. What `holds` reads of the tree (a span, an SVG element, a `layout` element, a
  `motionValues` binding that moves a box, the shapes an `<svg>` draws) is `PaintStatics`, kept per element while its
  `subtree_revision` and its parent are the same and pruned when the map doubles; a `<text>` in a `<text>` is read every time, since
  what makes it an SVG element is above its parent.
- **Their clocks advance without a build.** `CssAnimations::advance_clock(id, now)` and the same for transitions move the runs to
  `now` as the first half of a frame does (`Run::tick`, shared with `advance`), report iterations, ends and finishes, and note
  whether a run still moves. A dormant run is not ticked until something can be due: `Run::quiet_until` is the next of the start,
  the next iteration boundary, the end and the finish, less a millisecond (an hour for a held clock; nothing for a run going
  backwards or a `play()` waiting for a frame). `CssAnimations::advance_dormant` ticks from a due queue (a heap by `quiet_until`,
  one live entry per element) and from a list of elements to look at in the next tick whatever it says (new, touched by a build or a
  command, a run that cannot say when it is due), so a tick visits the runs whose boundary has come. `animationiteration`,
  `animationend` and the finish events come at the frames a tick of every dormant element would give them. Dormant transitions are
  looked at only while one runs. `Retain::take_dormant_moves` tells the renderer who fell asleep and who woke, so the two stores
  keep their dormant set by `enter_dormant` and `leave_dormant` instead of being given the whole set every frame.
- **A tick that has only dormant work draws and presents nothing.** `GpuixView::dormant_tick` is a `Window::on_next_frame` callback,
  armed when a dormant source has something to tell ([wake times](#wake-times-90)). It moves the runs and transitions to `now`,
  steps native motion, emits the events and sets `built_at`, so `getAnimations()` reads the instant of the tick, and it does not
  notify the view. A patched tick moves the dormant clocks the same way before it builds its units.

A hover over 5000 cards clipped out of view with colour loops went from 37 to 43 ms to 3.0 ms (0.4 ms with no cards), and an idle
tick of them takes 0.00 ms. The remaining hover cost scales with the roots a frame replays, at about 0.5 µs a card; see
[retention.md](retention.md).

**What is dormant is narrower than what is culled.** A span, a `layout` element and a child spliced out of an animating
`display: contents` element are not dormant, and neither is a card in the overscan of a scroller: it is recorded in a region wider
than the clip and is not walked culled, so its loop is built as a visible one's. An element whose `opacity` is animated is not culled
in a scroller either (it is built every tick there as well), so a bound or animated `opacity` is not dormant. A positioned `<svg>`
still blocks culling, so it is never dormant and the offscreen cost of its loop is what it was. An `<input>` still blocks culling:
its key and input handlers are registered by its prepaint and paint, which a culled subtree does not run, so a focused input
scrolled out of view would stop taking text. It is never dormant, and an input outside the clip is prepainted, but it arms no blink
and asks for no frame while its caret cannot be seen.

## Wake times (#90)

A looping `motion` animation on culled content used to run `dormant_tick` at every display frame, and each run synced every motion
on the page (`sync_motions`, `parent_inherited`) though nothing was drawn: about 3.5% CPU per loop. A loop under `display: none` was
worse, since it is not dormant: every tick was a whole frame (60 built frames and 4800 motions synced over 60 ticks of 40 cards). A
culled CSS loop and a culled bound motion value ran a tick at every frame too, and a patched tick beside a visible loop stepped
every culled motion.

Chrome runs an animation on content it does not show without painting for it, and one that reports nothing (a loop with no
listener) is not run at all until it is visible: what it shows is a function of the time. So a dormant source says when it next has
something to tell and the window asks for no more.

- **A dormant source says when it next has something to tell** (`dormant_wake.rs`): a `Wake` is `Never`, `NextFrame` or
  `At(instant)`, merged by the earliest, and `GpuixView::wake_dormant` asks for no more than that. `NextFrame` (and an `At` that has
  passed) queues the frame callback of `dormant_tick`; a later `At` holds an executor timer for the wait that then queues it;
  `Never` drops the timer and asks for nothing. A new wake replaces the timer in place. The end of a frame, of a patch and of a
  dormant tick all go through it (`GpuixView::dormant_clock_wake` merges the CSS animations, transitions and motion values; the
  motions' wake comes from the split below).
- **`MotionState::wake`** is `At(end)` for a timed tween or keyframes (delay and finite repeats counted), `Never` for a repeat
  without a count, and `NextFrame` for a measurement that is pending. A spring that plays once, or a finite number of times,
  says `At(rest)`: the first instant a frame sees it at rest, which a 60 Hz scan of the closed form finds to within one step and a
  bisection of that step pins down (`Span::rests`, kept per track until its keyframes or entry speed change). A spring still moving
  at the end of the 20 s scan has no instant to give and stays `NextFrame`.
- **`CssAnimations::dormant_wake`** is the earliest instant a dormant run starts (the end of its delay) or ends, taken from a heap
  of them (`Sleepers::boundaries`), and its next iteration only for an element whose event path listens for `animationiteration`
  (`path_listens`, which is also what gates the emission; Blink's `RequiresIterationEvents`). Which iterating elements listen is
  asked again when the tree's revision moves. A run that cannot say (a `play()` waiting for a frame, a negative rate, an element
  just built or commanded) is `NextFrame`; a held one, and a loop nobody listens to, `Never`. `Run::events` holds the two instants
  beside `quiet_until`, which still decides which runs a tick looks at. `animationstart` and `animationend` wake whether or not
  anything listens, since the `Animation` objects of `getAnimations()` listen by existing.
- **`CssTransitions::dormant_wake`** is the end of the delay and the end of each dormant running transition (`Playback::wake_at`).
- **`MotionValueStore::dormant_wake`**: a moving value with a `change` listener is `NextFrame` (Motion's `change` follows the
  animation, not the element being seen); one with only an `animation` listener is the end of its animation when that is known
  (`MotionValues::wake`: a tween's clock, a repeat's end, a spring's rest); one nobody listens to is `Never`, whoever binds
  it. A follower (`Node::Spring`) wakes at its own rest while its source is still, and is `NextFrame` while its source moves (a
  loop without a count, which has no wake of its own, included): it retargets with each frame it is sampled in.
  `advance_dormant` only finds the events of the listened values and no longer samples the bound ones: the frame that draws an
  element again does, and a spring follower catches up (`MAX_CATCH_UP_FRAMES`). It leaves `frame_moving`, `frame_values` and
  `written` as the last build left them, which the frame that builds an element after it wakes has to find. `change` still comes at
  the display rate, `animationStart` and `animationComplete` when they happen, and a `finished` promise resolves out of view.
- **A motion with no box sleeps like a dormant one** (`GpuixView::motion_sleeps`: dormant, or hidden by `display: none` or a
  `content-visibility` ancestor), and so does a value bound only to such elements (`value_sleeps`), so neither asks for a frame. CSS
  animations and transitions under `display: none` are cancelled and their state dropped.
- **A tick steps what is awake or due.** `step_motions` splits the motions that move into the ones that are drawn and the ones that
  sleep (`MotionSplit`, taken at the end of a frame and after a step), steps the first, and the second only when the earliest of
  their wakes is due; `MotionStep` returns the awake ones and that wake. `MotionValueStore::step` leaves a moving value bound only
  to sleeping elements as it is (`BindingIndex::bound_only_to`). A frame built whole does the same (above).
- **`getAnimations()` and the commands of an element that is dormant read the clock**, not the instant of the last frame: no frame
  or tick need have come for it for any time (`GpuixView::api_instant`).
- **`getFrameWorkCounters().dormantTicks`** counts the runs of `dormant_tick` (`resetBuildCounters` does not clear it).

Dormant ticks over 60 ticks of 40 culled cards, clipped by an `overflow: hidden` scroller: a motion loop 60 before, 0 after; a CSS
colour or stroke loop with no listener 60 to 0, and the page costs what an empty one costs (painted frames, patched frames,
elements built, motions synced all 0); 20 culled bound motion values with no listener 60 to 0, with a `change` listener one a tick as
before. With an `onAnimationIteration` listener, 200 ticks of 40 loops of 1 s take 200 dormant ticks before and 3 after (one per
iteration), each delivered in the tick that passes its boundary. Culled tweens, CSS animations and CSS transitions of 500 ms end in
the tick that passes 500 ms, with 32 dormant ticks before and at most 2 after. A patched tick of one visible motion loop beside 40
culled motion loops and 40 culled CSS loops syncs 41 motions before and 1 after, the work of the visible loop alone. Under
`display: none`, 60 painted frames and 4800 motions synced before, 0 after. Over 150 ticks of 20 cards, a culled or skipped native
spring takes 40 dormant ticks before and 1 after, a spring motion value with no listener 41 before and 1 after, and a follower of a
value at rest 41 before and 1 after; the completion comes in the tick it does for the same spring in view. A spring with a `change`
listener keeps a tick a frame.

## Skipped content (#97)

Skipped content (`content-visibility: hidden`, or `auto` scrolled far away; see
[observers-and-content-visibility.md](observers-and-content-visibility.md)) costs the window no frame. A page of cards that each
run a `motion.div` loop, a `motion.path` `d` loop and a CSS colour loop draws nothing over 60 ticks, whether the loops started in
skipped content or were running when it began to be skipped: 0 painted frames, 0 patched, 0 dormant ticks, 0 motions synced, the
same as 0 cards. Two things used to cost, and are fixed:

- **A whole frame rebuilt the path to every skipped host.** `running_motion` named a motion by `is_animating` alone, so a motion
  under a host that skips (no box, nothing built) was a running source: `compute_deltas` put it in `changed`, the spine of the frame
  took its host and every ancestor, and a hover frame over a sidebar rebuilt the page around eight skipped hosts instead of
  replaying it (300 elements built over 20 hovers, 120 for cards that run nothing). It now leaves out a motion whose host has no box
  (`is_hidden`: `display: none` or a skipping ancestor; an `<svg>` shape counts as its `<svg>`), so a skipped subtree has no running
  source, as `Retain::skip_content` says. A motion on the skipping host itself is not skipped content and runs as before.
- **A tick that changed nothing drawn was drawn whole.** A paint-only write to a motion value bound inside skipped content requests
  a tick (`Repaint::MotionWrite`); the preview found no unit (the element is skipped), and `build_patch` declined it as `NoUnits`,
  so gpui drew the whole frame: 20 writes, 20 painted frames. A preview with no unit now steps the clocks and calls
  `repaint_in_place` with no root, which builds, lays out and presents nothing: gpui counts it in `PatchCounters::empty_ticks`
  (`getPatchCounters().emptyTicks`), and not in `patchedFrames`. `step_clocks` emits the transition and animation events the units
  would have. A preview with no unit but with elements about to enter the dormant set (or whose verdicts moved) is still drawn
  whole, counted as `Dormancy`, since the frame is what settles that: left to an empty tick, culled transitions never became
  dormant and their `transitionend` never came. `NoUnits` is no longer a key of `unpatchable`; `Dormancy` is.

20 hovers with 8 skipped hosts of looping cards: 300 elements built before, 120 after (the number for hosts that run nothing). 20
writes of a motion value bound in 8 hidden hosts: 20 painted frames before; 0 painted, 0 patched, 0 declines and 20 `emptyTicks`
after.

**An `auto` host inside the margin but clipped away** by an `overflow: hidden` scroller is not skipped content: it is built and culled, so its loops are dormant like those of any culled card. This holds where the host began visible and was scrolled or pushed out above or below the clip. Below the clip the content mask is empty, and an empty mask culls every child tested against it (see [culling](retention.md#culling-clipped-content-38)): 0 painted, 0 patched and 0 declines over 60 ticks, the cost of an empty page.

## Hover patches

A hover that only changes how elements paint (a row that takes another background colour under the pointer) is drawn like a tick:
the roots that hold the restyled elements are built again and gpui writes the primitives they paint over the frame shown, where it
used to be a frame built whole. Three parts: the classification of a hover, the route from the pointer to a tick, and the roots a
patch can repaint ([Patch roots](#patch-roots)).

### Which hovers paint only

`events/hover_paint.rs` decides, from the styles alone, and `HoverChange::restyle` in `events/dispatcher.rs` applies it to the
elements a hover change moves: it says `None` (no element that entered or left declares a style for it), `Paint(ids)` or `Whole`.
A refinement paints only when the style it resolves to (`resolve_pointer_states`, the same fold a build makes) differs from the one
without it in nothing but:

- `backgroundColor`, and `background` when it is a colour (a gradient is not looked into);
- `color`, `outlineColor`, `textDecorationColor`, and every border colour in any spelling: the colour longhands, `borderColor`, and
  the shorthands (`border`, `borderBottom`, ...) when the width and style of every side stay what they were (the sides are parsed,
  as a collapsed table reads them); the outline shorthand likewise;
- `boxShadow` when the layers keep their offsets, blur, spread and `inset`: only the colours differ;
- `opacity`, while the element stays on the same side of 1 (a value below 1 makes an effect group, so crossing 1 changes the
  kind of what is painted).

**A colour has to keep its visibility, except a background.** A patch writes the primitives of an operation over the ones it had,
so the operations must be the same ones, and gpui paints no quad for a transparent border, no glyph for a transparent text and no
shadow for a transparent one: a hover that takes one of those from invisible to visible adds an operation, and is `Whole`. A
side of a border that draws nothing (no width or no line) has no visibility to keep.

The background is kept. A hover that gives a background to an element that had none (the mailbox row of ghia-bench:
`hover: { backgroundColor }` over no background) would add a quad to the operations of the root, and a hover back would take it
away. So an element whose `hover` or `hasHover` sets a background colour (`StyleDesc::keeps_background_quad`) is built with a fully
transparent background where it has none, and with gpui's `Style::keep_transparent_background` set, which makes gpui paint the quad
of a transparent background ([syncing-upstream.md](syncing-upstream.md#a-transparent-background-quad-that-is-kept-zed-stylers-sceners)).
The quad is in the root both ways and the hover writes a colour over it: `hover_paint::background_quad_kept`. The kept quad takes
no part in a hit test (a background never does: the hitbox of an element is its own, and `pointer-events` decides it) and paints
nothing, so the page is the page of a build without it. It does not apply to a background that is more than a colour
(`background-clip: text`, which makes the colour a layer of its own, an image, a gradient, a colour the root context does not
resolve): those compare as before. (A first version let the patch find out: the operations differed in number, gpui declined as
`Operations`, and the tick was a patch attempt and then the frame built whole, 13.0M instructions a crossing in the mailbox proxy
against 8.7M.) `active`, the group states and the focus states are not kept: they are frames built whole for another reason, and a
quad per element for them would be paid for nothing.

Everything else is compared whole, so a property this module does not list is not paint-only: layout, font, `transform`, `cursor`,
`zIndex`, a gradient, a custom property. A `transition` declared on the element, in the refinement, or (when `color` changes, which
descendants inherit and would start a transition from) below it, makes the hover whole, since a transition started by the hover
is a build that a patch does not make. `whileHover` is never paint-only, and neither is a style with `@container` rules.

- **`hasHover`.** An ancestor whose `:has(:hover)` state changed is named when its `hasHover` refinement paints only.
- **A group is `Whole`.** An element that declares a group (`group`) restyles its followers, which may be anywhere below it, and
  a root that holds the group or a follower is not left unrecorded for a patch (see below). `groupHover` followers are
  therefore a frame built whole.
- **Several elements** (a row and the text in it) are named together; one that is not paint-only makes the whole change `Whole`.

`hover_would_matter`, which the scroll-only frames ask, is true for `Whole` and for a change a listener hears, and false for `Paint`: a hover that only paints does not hold a translate, the tick after it repaints the rows (see [Under a wheel](#under-a-wheel-slice-g3e)).

### From the pointer to a tick

`dispatcher::update_hover` leaves the elements of a `Paint` change in `PointerState::paint` and says the view needs no frame
(`Output::restyle` false); `dispatch` hands them out as `Output::paint`, empty whenever anything else in the same input restyles
(`restyle` true: a press that changes `:active`, a hover that is not paint-only), since a frame built whole draws them, and keeps
them in `PointerState::paint_pending` for the tick. The four places that deliver an input (the deferred move through `submit`,
a press, a release and a file drag in `events/listeners.rs`) ask the window for a tick, `Window::request_tick`, where they used
to notify the view. A hover whose boundary events have a listener (on the path of the element, or on `window`) is `Whole`: the
script may answer it, and the frame it asks for is built whole as before.

The tick is drawn by a patch frame if the patcher takes it and by a frame built whole in the same draw if it does not (the
window is dirty and the view renders, as for any tick), so a decline for any reason still shows the hover: the frame takes the
pending elements and the pointer's chain as it takes any other source. With patching off (`setPatchEnabled(false)`,
`GPUIX_PATCH_OFF`) or the retention off the tick is always whole.

### Patch roots

A patch repaints a retained root, so the frame built whole has to leave the roots that a hover or a commit can restyle ready to be
repainted, before the pointer arrives or the commit lands. These are the *patch roots*: gpui keeps what it needs of a root's surroundings when it records it (`retained(..).patchable()`), and Ghia
keeps what builds it again.

- **Which roots.** `Retain::can_be_patch_root` says, per subtree revision, whether an element is a candidate, and the subtree holds
  at most `PATCH_ROOT_MAX_ELEMENTS` (64) elements (a row, a card or a small control, not a page of cards) and has no size an
  intrinsic keyword gives and declares or follows no group. It is a candidate when one of:
  1. it, or something below it, declares a hover that only paints (`hover_paint::declares_paint_hover`: all it declares of `hover`
     and `hasHover` paints only, it has no `@container` rule), and nothing is lifted out of it;
  2. it is a row of a virtual list, whatever its style (a commit restyles rows that declare no hover: the selection). What a
     relocatable row holds is built whole already (its children keep no recordings), so the flag asks nothing more of the build, and a
     row consumes what is lifted in it;
  3. nothing in it is worth a root of its own (`Retain::worth`: no element below it has a child or is costly to build, so none of
     them is recorded or skipped by a frame), it lifts nothing, and nothing runs or sleeps in the window (`Retain::quiet`). A patch root
     records nothing inside it, which for such an element changes nothing that is recorded, where a unit in it (something runs on
     it) would be taken from the frames. This is decided from the tree and not from the record of the last build of the root (which
     says the same for a root built before), since the pass that builds a frame again to compare it sees the record the first pass
     made (see below). `quiet` is the one input that moves with a frame: it is taken when the first pass of a draw begins and kept for
     the passes after it and the pass that is compared. The element itself has to be worth a root, or there is nothing to patch.
  The outermost recorded or skipped root with the flag is a *patch root* (`Record::patch_root`) if nothing is lifted out of it
  and nothing runs on it (`to_record` leaves a root with a running animation unrecorded: it is built every frame). A patch root is
  wrapped as `gpui::retained(..).patchable()` and its `FrameEnv` is kept in the plan (`Plan::patch_roots`, `Plan::patch_root_ids`),
  next to the units of running animations and apart from them: nothing runs on it, so it is not a source for a time-driven change. A
  scroller in it is no reason to refuse it: its offset is a source of its own. A patch root is what gpui keeps a `PatchUnit` and the
  surroundings of for every frame, so the more roots there are, the more a frame built whole costs (measured below).
- **What is built inside a patch root is built whole and recorded by no root of its own** (`Retain::patch_root_unit`, as in a unit:
  nothing inside is skipped, and no node inside is recorded), so that a patch, which builds the root as one piece, lays out,
  registers and paints what the recording of the root holds (a nested root is a `retained` element that registers dispatch nodes of
  its own: 74 against 122 in the first page tried). A frame built whole that rebuilds a patch root therefore builds everything in it,
  where its nested roots would have been replayed; the cap is what bounds that. This is decided before the root is built, from
  the tree, so it has to be right for the roots that are recorded:
  - nothing in the subtree **might lift** (`hover_paint::may_lift`: positioned, a `z-index`, an opacity below 1, a transform,
    a filter, a mask, a clip path, `content-visibility`), unless the root is a row of a virtual list, which consumes whatever is
    lifted in it (`lift_absorbed`): a root that lifts is recorded as one that hands elements to the stacking context around, and
    leaving the roots in it unrecorded changed how it replays (found by the retention fuzz under the verifier);
  - nothing in it has a **size an intrinsic keyword gives** (`min-content`, `fit-content`, ...): its box is measured under another
    style and asked for again, and a retained root that holds one is laid out again by every frame unless the box is a root of its own
    (`retained-intrinsic.test.tsx`);
  - nothing in it declares or follows a **group**, which the verifier found a patched root of mismatching its frame built whole
    (`group-state.test.tsx` under `GPUIX_RETAIN_VERIFY=1`); the cause was not found, so a group is a frame built whole.
  A pass that only lays out builds the root the same way, and registers nothing.
- **Where the environment comes from.** A root that is built keeps the `BuildStart` taken when it was entered, which is why the flag
  is asked at `enter` (`Entry::patch_root`); a root that is skipped (`retained_root`) has it from the skip. Off with patching
  (`Retain::set_patch_roots`).
- **The preview.** A tick takes the hover from `Sources::hover_paint`, the elements the dispatcher left in
  `PointerState::paint_pending`, and does not look at the chain's difference (it is the dispatcher's classification that says
  whether anything needs to be repainted): `compute_deltas(preview)`. Each element is mapped to the innermost unit or patch root
  that holds it in the last frame built whole, walking up the tree; an element no root of the frame holds (the frame skipped the
  root above it, so it never visited it, or the root is not a patch root) is `Unpatchable::Hover(id)` and the frame is built whole:
  that frame visits the roots, and the hover after it is patched. A root the frame has elsewhere than it was recorded by a frame built whole that replayed it (a list or a scroller
  scrolled since, the replay put it from a recording made elsewhere) is asked of gpui before it is built (`Window::patch_blocker`), and counted as `Hover:Relocated`.
  A row a translate moved is not one: the translate keeps its unit, and a patch of it paints in its region ([Under a wheel](#under-a-wheel-slice-g3e)).
- **After a patch.** The recording gpui holds of a patched root is of the paint before, so the elements the patches repainted are kept
  (`Retain::hover_patched`) and the next frame built whole puts them on its spine, which builds the roots above them and records
  them again. A frame built whole takes `hover_paint` and the patched elements as it takes the difference of the chain.
- **A new row is ready from its first build.** Whether a root blocks the roots in it is decided from the tree and not from the record
  of its last build, so the first hover of a row that came into view is a patch like any other. (The record was tried: the
  pass that rebuilds a frame to compare it sees the record the first pass made, and has to build the roots in it as the first pass
  did.)

**Cost of the wider roots.** Rows of a list and roots with nothing worth a root in them are patch roots (the `PatchUnit` and surroundings
gpui keeps for each) without a hover. The mailbox rows were hover roots already, so it measures as the same page, two runs each back to
back, before and after (release addon, `A11Y=0`): `PHASE=scroll` mean 7.510M and 7.495M, median 6.82M and 6.82M before; mean 7.491M and
7.477M, median 6.81M and 6.81M after; `PHASE=hover` crossing median 4.05M and 4.05M before, 4.04M and 4.03M after (18 of 18 patched);
the Navigate proxy `APP=App` mean 41.1M and 41.1M before, 41.3M and 41.3M after (median 38.6M and 38.6M, then 40.5M and 40.6M: the
distribution is bimodal and the median moves by one key, per key the same within noise); `APP=App-detailstatic` median 16.0M and 16.0M,
then 15.9M and 16.0M. The widening does not help the mailbox: a key that scrolls the list is still a frame built whole.

**Measured** (the mailbox proxy of ghia-bench on the test renderer, release addon, `PHASE=hover A11Y=0 bun mailbox-scroll-hover/profile.tsx`,
instructions per row crossing, 18 crossings of 480 ticks, two runs each back to back; patching off is `GPUIX_PATCH_OFF=1`, which is
the frame built whole every hover used to be, and the tick it asks for builds nothing):

| | patching off | patching on |
|---|---|---|
| the bench app as it is (the row has no background, a hover gives it one) | mean 9.35M and 9.33M, median 8.67M | before the kept background quad: the same, a frame built whole (`Whole`): mean 9.32M and 9.38M, median 8.66M. With it: mean 4.48M and 4.51M, median 4.05M and 4.04M; 18 of 18 crossings patched, 1 scene rebuild |
| a row with a background of its own (`ROW_BG=1`) | mean 9.61M and 9.71M, median 8.90M and 8.94M | mean 4.70M and 4.70M, median 4.07M and 4.09M; 18 of 18 crossings patched, 2 units each, 0.06 scene rebuilds a crossing |

With a background of its own the hover costs 51% less (mean), and the bench app as it is costs about the same since the kept quad (a
build on the same machine, the row crossings before and after: mean 8.57M and 8.61M, median 7.84M, none patched, to mean 4.48M and 4.51M,
median 4.05M and 4.04M, all 18 patched: 48% less). What is
left of a patched crossing is the rows built (18 elements, 2.9M), the input dispatch and the fixed cost of a patch; a patched row
still builds its 9 elements, where a row whose children kept their recordings would build one (not done: see the limits). The scroll
phase (`PHASE=scroll A11Y=0`), where the row under the pointer changes while the rows are translated, was what it was for a row with
a background of its own: mean 9.03M and 9.03M with patching on, 9.02M and 9.01M off. The kept quad is one primitive more in every
row that declares such a hover: the scroll phase of the bench app as it is went from mean 7.64M and 7.63M to 7.89M and 7.88M (+3.2%,
median 6.87M to 7.14M; 14 more replayed primitives and 18 more bounds inserts a tick), the price of the quad.

Two things found by measuring: the patch compared every operation of the two rows by their debug form (formatting two floats-heavy
structs, a hundred thousand instructions each), 25.7M of a 27.9M tick (`PaintOperation::differs_from` compares the fields of
glyphs, quads and markers first now); and half of the patches made the scene again, because the recording of a row put elsewhere
marks `Replaced` with `derived: true`, which a build at the row's own place does not, and a patch tried to write the marker.

**Limits.**

- A hover that adds or takes away a primitive (a shadow, a border colour from transparent, a text colour from transparent, a
  background that is more than a colour) is a frame built whole; so is a group, a root that might lift, a size by an intrinsic keyword, a root of more than 64 elements, and a
  row that a frame built whole replayed from a recording made elsewhere (`Hover:Relocated`: a whole frame after a scroll replays the rows with
  a delta, and builds one again only when something changes it, so the hover of that row is a frame built whole, which records it where it stands; a row a translate moved is patched).
- A page of at most 64 elements is one root: a patch builds all of it, as a frame built whole does.
- A patch root that a frame built whole rebuilds builds everything in it.
- The children of a relocatable row cannot keep their own recordings (`Retained::prepaint_in_scope`), so a rebuilt row builds all its
  elements. Letting them replay inside the row's recording when the row is rebuilt needs nested relocation semantics (a root nested in
  a relocatable one recorded in the region of the first, replayed into a scratch frame by a patch, with hitbox ids and registrations
  that the patch hands out in order): not done, and an open design question.

## Commit patches

A commit from JS that only changes how elements paint (the mailbox row of ghia-bench: `rowStyle` to `selectedRowStyle` when the
selection moves) is drawn like a hover: the roots that hold the restyled elements are built again and gpui writes the primitives
they paint over the frame shown, where it used to be a frame built whole and, for a read of the scroll metrics after it, a layout pass.

- **Classification, in the tree** (`RetainedTree::settle_style_change`). A style change that only paints
  (`StyleDesc::differs_only_in_paint`) is also *strict* when a hover of the same change would be a patch:
  `hover_paint::restyle_paints_strictly` compares the style the element resolves to before and after with `differs_by_paint_only`, with no
  state and with each state either style declares, and wants `keeps_background_quad` the same before and after, no transition on
  either (nor below the element when its `color` changed), no group and no `@container` rule. A state style (`hover`, `hasHover`,
  `focusVisible`, ...) that both styles declare and that differs in paint alone is a paint change for `differs_only_in_paint` too (it
  compared the state styles whole, so `rowStyle` to `selectedRowStyle`, which changes `backgroundColor` and `hover.backgroundColor`, was
  `Dirty::Layout`); one that only one style declares is still layout. A strict restyle takes the revision as any, and is noted in
  `RetainedTree::pending_restyles`; any other mutation (any mark that is not paint, the universal style, a paint restyle that is not strict)
  moves `RetainedTree::patch_barrier` to its revision. The classification is on while the view patches ticks and the retention plans
  (`GpuixView::sync_commit_patching`; the tree is what `applyBatch` has, and the view may be leased by the input that made the batch).
- **Routing.** A batch whose restyles are all strict is `Dirty::PaintPatchable` (`Clean < PaintPatchable < Paint < Layout`, so one
  batch or several flushes in between that are not all strict are `Paint` or `Layout` as before). `invalidate_after_mutation`, which
  `applyBatch` (live and test renderer) and the sync-dispatch route (`events/sync_dispatch.rs`) go through, asks the window for a tick
  (`Window::request_tick`) for it, where it called `notify_paint_only` for `Paint`. A request for a tick leaves the layout current as
  `notify_paint_only` does, so a read of `scrollTop` or `clientHeight` after the commit runs no pass; a tick that cannot be patched is
  drawn whole in the same draw. The elements wait in the tree (a tick peeks them) and a frame built whole takes them
  (`Retain::begin_frame`), as a patch does after it (`continue_after_patch`), as the pointer keeps `paint_pending` for hover.
- **The preview.** `Retain::preview` no longer says `Edited` because the root's revision moved: it says it when the patch barrier is
  newer than the revision the frame shown was built at. Each pending element is mapped as a hover's is (the innermost unit or patch root
  of that frame, walking up); an element no root holds is `Unpatchable::Commit(id)` and the frame is built whole, which visits the
  roots; a patch root that gpui has since put elsewhere (a list scrolled) declines through `Window::patch_blocker` as `Commit:<blocker>`.
  The patcher builds the roots with `build_unit` from the live tree, as for a hover. What an earlier patch repainted needs no note: its
  revision is newer than what the root recorded, so the next frame built whole builds it again (the verifier agrees).
- **The scroll classifier** still compares the root's revision with the frame shown, so a list scrolled after commit patches is
  built whole once (`Edited`).

The roots are the units and the patch roots of the last frame built whole, which include a row of a virtual list that declares no hover
and a root with nothing worth a root in it ([patch roots](#patch-roots)). An element that no such root holds (the header outside the list;
the outer element of a root that has a root of its own in it) is `Commit`.

**Measured** (the Navigate proxy of ghia-bench, `examples/solid/mailbox-navigate`, release addon, `A11Y=0`, 30 keys, instructions per
key over keys 2 to 30, two runs each). The selection-only variant (`APP=App-detailstatic VERIFY=0`): median 16.0M and 16.0M against
18.8M before, and no forced layout pass on any key (it was one a key, 3.6M). A key is a patched frame while the selection stays in the
view (7 of the 30: 6.7M to 13M); once the key scrolls the list (`reveal`) the scroll queues the view, which is a frame built whole
(`PendingView`), so the rows still cost their build there. The bench app as it is (`APP=App`, the detail remounts, which lays out):
median 40.7M and 38.5M against 38.5M to 39.8M, as before. The hover crossings of `mailbox-scroll-hover` are what they were: median
4.04M and 4.06M, 18 of 18 patched.

**Limits.**

- A commit that adds or takes away an operation (a background where the element keeps no quad, a colour from or to transparent, a
  shadow, an opacity across 1), changes a box, or restyles an element that is in no root is a frame built whole.
- A commit patch builds every element of the root it repaints (a row: 9 in the bench) and draws what the roots paint; the frame is not
  cheaper than a hover's.

## Contained-layout patches

A commit whose changes (a text that rewraps, a child added or removed, a style that moves boxes) all lie inside a scroller is drawn
as a patch of that scroller: it is built again and laid out, gpui accepts the patch when nothing outside it moved, and no frame is
built whole. Without it every commit that lays out costs the fixed frame (12M instructions in the Navigate proxy) whatever it
changes. This needs the contained relayout patch of gpui, which is opt-in per window
([syncing-upstream.md](syncing-upstream.md#contained-relayout-patch-zed-4359857078-afccad7649-f9a51894e7-06fc9e85e3-b133d12651-52f5a22f76-c4590da472-third_partytaffy-taffyrs-windowpatchrs-windowpatch_splicers-elementsretainedrs)):
the patcher turns it on with `Window::set_contained_patches`.

- **Anchors.** A scroller (`overflow` `auto` or `scroll` on an axis, with a scroll handle) is wrapped by the frame built whole as
  `gpui::retained(id, key of this frame, built).patchable_relayout()` and kept in the plan with its `FrameEnv`
  (`Plan::anchors`, `Retain::begin_anchor`, `end_anchor`, `anchor_root`): recorded by every frame built whole as a source for a
  patch, and replayed by none (its key is not the one of the frame before, as a unit's is not). The scroller stays an element
  every frame builds (`Exclusion::Scroller`) and what is in it keeps its roots, so a scroll still moves them. It is an anchor
  when nothing else is excluded in it (no nested scroller, virtual list, custom element, `layout` animation, highlight, ...),
  nothing runs in it, nothing in it is lifted out or placed against a block outside it, it is not itself absolute or lifted,
  and it holds at most `ANCHOR_MAX_ELEMENTS` (1024). An anchor is tried before a patch root for a scroller: a scroller is never
  recorded as a root.
- **Which commits.** The tree notes the elements a commit changed (`RetainedTree::pending_structure`: props, style, text and children
  other than a strict restyle by paint; a created element is covered by the element it is put under, a destroyed one by the
  parent it left) and moves `patch_barrier` only for a change no element is named for (`setRoot`, the universal style,
  `autoFocus`, `testId`, `white-space` below an element). While the frame shown has anchors (`RetainedTree::set_anchors`, published
  by `Retain::publish_anchors` when the frame is over) a batch whose changes are all attributed is `Dirty::LayoutPatchable`:
  `invalidate_after_mutation` asks for a tick (`Window::request_tick`) and notes the view in `LAYOUT_PENDING`, where a batch with
  an unattributed change notifies as before.
- **The preview.** `Retain::preview` maps each pending changed element, still in the tree, to the innermost anchor of the frame shown
  that holds it (walking up); one that no anchor holds is `Unpatchable::Structure` and the frame is built whole in the same
  draw, which makes the anchors the next commit is patched in. A restyle by paint, a hover or a running animation that lies in a
  relaid anchor needs no root of its own: the anchor builds everything in it, so it is dropped from the units. Anchors come
  after the units in the list handed to the patcher.
- **The patch.** `GpuixView::build_patch` builds each anchor with `build_unit` (retention suspended: everything in the anchor is
  built flat, nothing entered, recorded or skipped) and gpui lays it out again from the window's root. The tape captures what its
  prepaint and paint would write into the registries, and when gpui accepts the patch `TapeStore::replace_recorded` puts
  those in the place of what the frame wrote for the anchor: the boxes (`getBoundingClientRect`) are published and those of elements
  the anchor no longer paints forgotten, and the selection text, start regions, painted-text log and inline paragraphs take the
  place, in the registry's order, of the writes of the tape before (`Layered::replace`). The observers are swept after the patch
  as after a scroll translate. `Retain::anchor_repainted` drops the records of everything in the anchor, so the next frame built
  whole builds and records all of it: gpui's splice forgets the recordings of the roots nested in the anchor and around it, which
  are of the layout before, so none of them is skipped (`Plan::repainted`), and a unit or patch root in a patched anchor that a
  commit does not relay is `Anchor:StaleRecording` until a frame is built whole.
- **What the splice and the rewrite changed.** The anchor is built flat, so the patch registers other counts than the recording: gpui
  splices the ranges of the anchor into the frame (`PatchDecline::Splice` when it cannot) instead of declining `Operations`,
  `Hitboxes` and `Registrations`. An anchor that holds roots (text, boxes with children) and a keyed swap of the content with
  another number of elements are patched. gpui then rewrites the recording of the anchor from the patch
  (`rewrittenRecordings`), which is what lets the next commit patch it again. A root that published (every host element of Ghia
  reports its box through an `on_painted_layout` listener) keeps its rewritten recording when it has an `on_replay` hook, as a frame built
  whole accepts for the recording (zed `c4590da472`), so consecutive commits in an anchor are all patches. Ghia reads the outcome after
  each patch (the counter moved by the number of anchors patched) and keeps an anchor whose recording was dropped as `Plan::unrecorded`:
  the next commit that changes it is `Anchor:StaleRecording`, decided before anything is built, and the frame built whole after it
  records the anchor again.
- **Focus.** A commit that adds, removes or changes a focusable element in an anchor runs `sync_focus_handles` first (the step
  of a frame built whole that gives elements their handles, drops those of the ones that went and moves nothing else that the
  frame would not), so the anchor is built with the handles the tree needs: a click, Tab and `focus()` reach the new content
  of a patch frame. `Anchor:Focus` is no longer declined.
- **Declines.** gpui declines `NotContained` when something outside the anchor moved or the anchor's own box changed (a detail
  that is as wide as its content, with a sibling that shrinks), `StaleRecording` when it has no recording of the anchor (only
  when Ghia could not tell: Ghia declines first), and `LayoutMismatch` while an accessibility tree is built. Ghia declines before
  building: `Structure`, `Anchor:StaleRecording`, and `Anchor:<blocker>` for what `Window::patch_blocker` says. A declined patch is
  drawn whole in the same draw, with the layout work of the patch kept.
- **Reads.** A batch that moved boxes (`LayoutPatchable`) leaves the layout older than the tree while its tick is waiting. A read of
  boxes or scroll metrics before the draw (`settle_pending_layout`, called by every read that lays out) prepares the patch instead of
  running a pass from the window's root: `GpuixView::prepare_for_read` runs the preview the patcher would run, builds those units as the
  patcher does and hands them to `Window::prepare_patch`, which lays the anchors out onto their nodes, computes the layout from the root,
  checks nothing outside moved and prepaints them. The prepaint publications run at once, so the read answers from the registries with
  the post-commit boxes and scroll metrics of what is in the anchor and the current ones of what is outside it, and the draw does not
  lay out or build the anchors again (see [forced reads](forced-reads.md#a-read-while-a-contained-commit-is-pending)). The patcher finishes
  the prepared patch (`Window::finish_prepared_patch`, with the tape acceptance of any patch) when `prepared_patch_units` is what the
  preview names then; otherwise it builds as for any tick, and gpui drops the prepared patch. The view's pending layout is `Waiting`
  (nothing prepared), `Prepared` or `Notified` (the view was invalidated, so the next read lays out from the root and the tick is
  drawn whole). A framework that destroys what a handler's batch detached in a batch of its own after the handler returns (Solid's
  `finishRemovals`) discards nothing: destroying an element that `detach_child` took out of the tree is `Dirty::Clean` when patch frames are
  made (`RetainedTree::destroy_element`), since the batch that detached it already said the frame changed. Anything else that changes the tree or a scroller after the prepare (`invalidate_after_mutation`, a scroll write) discards the
  patch with `Window::discard_prepared_patch`, which leaves the layout it computed in the engine and loses the recording of the anchor,
  so the frame after a discard is built whole (`StaleRecording`) and records it again. A decline of the prepare (gpui's, `NotContained`
  for one) falls back to what a read did before: the view is notified, a pass runs, and the tick is drawn whole (`PendingView`); a
  preview that declines is counted in `unpatchable` as `Read:<kind>`.
- **Counters.** `getPatchCounters().relayoutPatches` (anchors repainted after a layout), `rewrittenRecordings` (of those, the ones
  whose recording gpui made again), the `declines` above of gpui, and in `unpatchable`: `Structure`, `Anchor:StaleRecording`,
  `Anchor:Relocated` and the like.

**Measured** (the mailbox proxies of ghia-bench, release addon, `A11Y=0`, two runs each back to back). The Navigate proxy `APP=App`: median
38.8M and 38.6M a key (excluding the first), as before; no key is patched: the bench Detail holds roots (texts, a box with children) and
its handler reads `scrollTop` after the commit, so every key is `PendingView` (30 of 30) and drawn whole as it was. `APP=App-detailstatic`:
16.1M and 16.1M (as before, 7 keys patched as commit patches). `PHASE=hover` row crossings: median 4.060M and 4.054M (4.04M before), and
`PHASE=scroll` median 6.889M and 6.893M, mean 7.543M and 7.568M (6.81M and 7.49M before: the retained root the detail's anchor is, in each
frame built whole).

**Measured, G1.5** (zed `b133d12651`: the splice and the rewrite; same proxies, two runs each). `APP=App`: median 40.5M and 38.7M a key
(excluding the first; the machine was busier than at G1), every key `PendingView` (30 of 30, from `reveal()`'s read of the scroll metrics), none
patched. `APP=App-noreveal` (no read): median 28.8M and 28.7M against 28.9M and 28.5M with `GPUIX_ANCHORS_OFF=1`, so the patch alone gains nothing
yet: 4 keys are relayout patches (keys 2, 4, 6, 8, as many as `Anchor:StaleRecording` keys, 4, the frame built whole that records the anchor
again, and no patched key costs less than the whole frame next to it but one: 29.3M against 35.4M), 21 are `Commit` (the row the
selection left or came to is held by no patch root) and one `PendingView`. `PHASE=hover` row crossings: median 4.095M and 4.069M, 18 of 18 patched
(4.06M at G1), `PHASE=scroll` median 6.893M and 6.896M, mean 7.569M and 7.539M (6.889M and 7.543M at G1).

**Measured, G2** (zed `c4590da472`: a read prepares the patch; same proxies, `A11Y=0`, two runs each, instructions per key). Keys 1 to 8 of the
Navigate proxy do not scroll the list (the selection stays in view), keys 9 to 30 do (`reveal` calls `list.scrollTo`). `APP=App`: median 38.5M and 39.2M
over keys 2 to 30 (38.6M to 40.5M at G1.5; 39.0M with `GPUIX_ANCHORS_OFF=1`), in two kinds of key. Keys 2 to 8: all seven are a relayout patch,
prepared at the read and finished by the draw, no layout pass, no whole frame: median 34.3M and 33.1M (40.1M with anchors off), and keys 4 to 8, which
are warm, 31.5M and 30.9M against 38.0M. The phases of those keys, medians: the read that prepares (`getScrollMetrics`) 17.3M against the pass of 19.3M, the
draw 9.4M against 14.2M, 32.1M in all against 39.6M. Keys 9 to 30: none is patched (22 of 22 `PendingView`; 21 of them are declined `Commit` at the read, a restyle of
a row that no patch root holds (the row the selection comes to is not in the frame shown), so the read lays out as before; the one that gets as far as a prepare, key 9,
is discarded by the scroll and costs 40.5M to 47.6M against 31.5M with anchors off, the price of a prepare that nothing finishes): median 41.1M and 40.6M
(38.3M with anchors off, keys 10 to 30 within 1M of each other key by key). `APP=App-noreveal`: median 28.7M and 28.6M (28.6M with anchors off); keys 2 to 8 are the seven
patches (30.7M and 33.7M, 32.4M with anchors off), the rest `Commit`. `PHASE=hover` row crossings: median 4.118M and 4.113M, 18 of 18 patched (4.07M at G1.5);
`PHASE=scroll` median 6.882M and 6.874M, mean 7.541M and 7.544M (6.89M and 7.54M). What is left of the patched key is what the estimate of the design
kept (the detail built, laid out and painted once, the rows) and it costs more than estimated: the prepare is 17.3M, of which the detail's text shaping and
layout is the most.

**Limits.**

- A scroll write after a read that prepared the patch (the bench's `reveal()` scrolls the list on the keys that move the selection out of
  view) notifies the view: the prepared patch is discarded and the frame is built whole (slice G3 is the list scroll that composes with it).
- A mutation after the read (a second commit before the draw) discards the prepared patch, and the frame that follows is built whole
  (`StaleRecording`): gpui's discard does not keep the recording the patch started from, where a second `prepare_patch` would take it over.
- Inside the dispatch of an input gpui draws no patch (`dispatch_depth`): the test window draws at the end of a key's dispatch, so a
  key handler's tick is drawn whole there, from the layout the prepare left; the live window draws it after the dispatch.
- A scroller is wrapped as a retained root that gpui records in every frame built whole: one root more built and painted per anchor
  (`getRetainedCounters().builds`, `getBuildCounters().painted`).
- With an accessibility tree built nothing is patched.

## Scroll-only frames (in progress)

Every wheel event over a `<virtual-list>` used to draw a whole frame (`ListState::scroll` sets the offset, runs the scroll handler and notifies
the view), about 12M instructions a tick in the mailbox proxy of ghia-bench, though the only thing that changed is where the rows are.
A frame like the patch of a tick, that moves the rows of the frame shown by the scroll and builds nothing, has three steps. **Slice 1**
is the bookkeeping and a classifier that says, before the frame is built, whether it would be a translate of the rows. **Slice 2a**
draws the frames the classifier calls a translate as one: the operations and hitboxes of the rows are put where their
recordings put them at the new position, what the rows wrote into the registries is moved, the scene is made again from its log, and
nothing is built ([The translate](#the-translate)). **Slice 2b (this)** moves the thumb of the list's overlay scrollbar in the same
frame ([The thumb](#the-thumb)), where 2a declined every frame of a list with a scrollbar as `Thumb`. **Slice 3** brings in the row at the
edge and repaints the hover inside the patch: both are not built, and the frames they would draw are drawn whole.

**Runs** (zed `window/scroll_patch.rs`). Each frame records, for every relocatable retained root painted inside a list (the rows,
`retained(..).relocatable(overscan)`, see [retention.md](retention.md#rows-of-a-virtual-list)) and not inside the recording of another
(a root nested in a row that was built keeps no recording of its own: the recording around it is what a scroll moves, and a run for it
would be a root that cannot be moved), a `ScrollRun`: its row, the range of
hitboxes and of scene operations it left in the frame (a row's operations are recorded even when the clip hides them, so the count does
not change while it slides under the clip), how far from its recording it was put (`Recorded::delta`), the content mask around it, whether
an exact clip cut it, and whether it was put from its recording or built. The hooks are in `Retained::prepaint` and `paint` (a root with
an overscan, inside a list), the list notes itself (`begin_list`, the row it is prepainting, `end_list`) and a list that prepaints again
after a rolled-back first try drops the runs of the first. A list leaves a `ListFrame`: the rows it built, how far it was scrolled (the
position `ListState::scrolled` reads, in the same terms each time), its viewport and padding. They live in the `Frame`, so a pass that
is thrown away and a frame that is cleared take them along. Off (`Window::set_scroll_patch(false)`, `GPUIX_SCROLL_PATCH_OFF=1`) nothing is
recorded and a draw pays one check; on, a frame pays one entry per row (a clone of the id, three ranges and a content mask).

**The mark.** `ListState::scroll` notes that a list scrolled (`Window::note_list_scrolled`) beside the `cx.notify` it already makes; the
next draw consumes it. A list moved by anything else (`scrollToItem`, a write) is not marked.

**The classifier** (`Window::classify_scroll_patch`, called by `draw` before the new frame is built, and not for a patched tick) works from
the frame shown: the list whose position is not the one its frame recorded, how far its rows move (the difference of the positions
rounded half up to a device pixel, which is how `prepaint_items` places a row), and the runs. Every check runs. The first of these that
holds, in this order, and stops a frame (all but `HitboxChain`) is the frame's reason (`getPatchCounters().scrollPatch.reasons`), and each
that holds is counted in `held`, so what else would stop the frame is known too:

| Reason | It holds when |
|---|---|
| `Other` | the owner has no whole frame shown (no gate, planning off, a layout-only pass since, an element that follows the clock), the frame has no list, more than one list moved, the list is settling its position (a reset, a pending scroll adjustment, following its tail), or the window was resized |
| `Edited` | the tree's root revision is not the one the frame shown was built from (a commit), a view other than the list's was notified, the window was refreshed, or a source other than the scroll differs from the frame shown (a press that restyles with `:active`, the focus, a selection, a measurement, a link, a command, a custom element, the scroll of a scroller that is no list: the owner says it, below) |
| `Membership` | a layout at the new position would build a row the frame shown did not paint, or measure one (`ListState::rows_needed` replays the walk of `layout_items` over the rows already measured; a row that only leaves is fine, because its operations stay and the clip hides them). The rows of the overdraw that are not measured are measured first, inside the draw, so only a row that shows with no size holds it ([slice G3d](#overdraw-measured-and-rows-built-again-slice-g3d)) |
| `Hover` | the pointer moved since the frame shown, or the hit chain under it once the rows move would restyle something or emit an event for a listener: the owner is given the chain before (the frame shown) and the one after (the hitboxes of the rows moved, the hit test run on them) and answers with what the dispatcher's `update_hover` would do moving the hover from the one to the other (an element entering or leaving that has a `hover` style, a declared group, `whileHover`, a `:has(:hover)` style on an ancestor; a pointer boundary event with a listener on the path or on `window`). The owner says yes for a hover that is a frame built whole (a restyle by more than paint, `whileHover`, a group) or that a listener hears, and no for one that only paints: that one is painted by the tick after the translate ([Under a wheel](#under-a-wheel-slice-g3e)). Asked only when `HitboxChain` holds and the pointer is where the frame shown had it; a pointer that moved since holds `Hover` without being asked (`hoverAsked` and `hoverMatters` below tell the two apart); a window whose owner does not answer takes every `HitboxChain` for a `Hover`. `hoverOnly` counts the `Hover` frames that nothing else stops: eligible with the pointer elsewhere |
| `HitboxChain` | a hitbox of a row that takes the pointer (not `PassThrough`) is under it before and not after the rows move, or the other way round. **Counted in `held` only**: the hit test is run again after a translate, so this alone stops nothing. It is the old `Hover`, which the children of a row crossing the pointer (an avatar, a text) held for almost every wheel event |
| `Place`, `Region`, `Clip` | `Recorded::place` would not put a row there (a `Region` or `Clip` miss of a row that stays is built again in the translate when the list has a builder, which Ghia's lists have, though since [slice G4a](#a-row-of-a-list-is-recorded-for-its-travel-slice-g4a) a row of a list does not miss `Region` while it shows, so for them only `Place` holds the frame, [slice G3d](#overdraw-measured-and-rows-built-again-slice-g3d)): what it reads of its surroundings differs in more than the offset (a scale factor that is not a power of two, an exact or rounded clip around, a general transform), the region the row was recorded in no longer covers the clip around it, or a rounded clip in it meets the clip differently (`ReplayKey::relocates_by`, `RelocationInfo::fits`, asked of the recording by `RetainedState::would_place`). `held` also counts `Region.top`, `Region.bottom` and `Region.side`: the edge of the clip the moved region leaves bare (the rows moved up by more than the overscan leave the bottom bare) |
| `Focus` | the frame shown, or a layout there, builds a row outside the viewport for the focus it holds |
| `A11y` | the accessibility tree is being built |
| `ScrollAnimation` | a smooth scroll or a scrollbar fade has frames of its own (the owner says it) |
| `Clock` | something that follows the clock has a frame to draw: a tick was requested for this draw (`Window::request_tick`: a transition, a keyframe animation, a motion value, the blink of a caret, a hover paint), or the owner says its last frame asked for another (`ClockAsked`, published by the frame that ran: a transition, animation or motion running, a motion value that wants frames). A translate builds nothing, and `draw` takes the tick (`patch.tick`) before it classifies, so a translate that took it would leave nothing to ask for the next frame and what runs would stand still until a frame built whole. The tick is kept as a flag of the draw (`ScrollPatchWindow::ticked`) and refused, not left set, so the tick is drawn by the frame that is built whole |
| `Thumb` | the thumb of a bar cannot be put where the scroll puts it ([The thumb](#the-thumb)): the bar of a list would be painted at another alpha, size or track than the frame shown painted it, would appear where the frame shown painted none, or is painted in a way that cannot be moved in place; or a bar of a scroll container is due a frame (`scrollbar::container_bar_stale`, said by the owner's gate). `held` also counts `Thumb.size`, `Thumb.alpha`, `Thumb.appear` and `Thumb.track` |
| `NotRelocatable` | a row of the frame shown has no run (it is not a relocatable root, or holds several: the runs are not the rows), a run has no recording, or its recording cannot be put elsewhere (built late, a hole, a position kept past the frame). `held` also counts `NotRelocatable.noRun`, `.noRecording` and `.unmovable` |

A frame with none is *eligible*. The owner's part (`Window::set_scroll_patch_gate`, `retain/scroll_gate.rs`) is `Edited` (the root's
`subtree_revision` against the one `Retain` published when it last recorded a whole frame, or a tree locked by an update),
`ScrollAnimation` (`scroll::animating()`, `scrollbar::needs_frames()`), `Clock` (`ClockAsked`, set by `GpuixView::render` and `continue_after_patch` from what they ask `request_next_frame` for), `Thumb` (a bar of a scroll container that is not a list's painted at an alpha or thickness
the clock has since changed, `scrollbar::container_bar_stale`: a translate builds no bar, so it would leave the end of its hold unseen) and `Other` (nothing to translate from), and, for `Hover`
(`Window::set_scroll_patch_hover`, the same file), whether moving the hover from the chain before to the chain after would restyle or
emit: `events::dispatcher::hover_would_matter`, which asks the code that `update_hover` runs (`HoverChange`: who enters and leaves, whether
one of them restyles, whether an event of the change has a listener on the path of the element it is for, or on `window`), of the state
the pointer is in (a captured or locked target is the target before and after) and of the tree (a tree locked by an update says
yes). It is a callback and not a state published with each frame (`Retain::publish_shown` is that, for `Edited`) because what it reads
is the style and listeners of the elements under the pointer, which a frame would have to copy for every element. The view notifies for sources other than the tree (a press that restyles by `:active`,
a selection, a measurement, a link, a command, relevance: `events/listeners.rs`) with the same entity as the list's notify, which the tree's
revision and the queue of views cannot tell apart, so the gate also asks what a tick asks: `GpuixView::with_sources` reads the sources as
`preview_tick` does (the code is the same: `preview_tick` is `with_sources` and `Retain::preview`), and `Retain::sources_changed` is a peek of
`compare_sources`, the part of `compute_deltas` that no clock moves, with the hover chain left out as a tick leaves it (the classifier asks
about the pointer): anything it finds, or a measurement, a link, a command, a relevance or a hover restyled by paint that no frame has drawn,
is `Edited`. The gate is given the `App` for it (`Window::set_scroll_patch_gate`) and reads the view only when it is not being updated.
What it cannot read (the view or the pointer state in use) is a change. A running motion, a transition or an animation is not a source
but a clock, which is `Clock`.

**The check.** After a frame is drawn whose prediction was eligible, `settle_scroll_patch` compares what it built with the prediction:
the rows it painted, a run for each, each put from its recording (not built) and moved by the delta the prediction gave. A difference
is `scrollPatch.mispredicted`. It is the check the translate relies on, so it is the number to watch for the classifier having been wrong; a frame that the translate draws is not built, so it has nothing to be compared with (the verifier does, see below).

`getPatchCounters().scrollPatch` is `{ frames, eligible, mispredicted, hoverOnly, hoverAsked, hoverMatters, patched, applyDeclines, reasons, held }` (`hoverAsked` and `hoverMatters` are Ghia's: how many frames the owner was asked whether the hit chain that moved would matter, and for how many it said yes, so `held.Hover - hoverMatters` is a wheel whose pointer is not where the frame shown had it), `applyDeclines`, `reasons` and `held` keyed by the names above (`applyDeclines` by [why a translate declined](#the-translate))
(all of them, zero included; `held` also has `HitboxChain`, counted for eligible frames too, and the causes `NotRelocatable.noRun`,
`NotRelocatable.noRecording`, `NotRelocatable.unmovable`, `Region.top`, `Region.bottom` and `Region.side`). `setScrollPatchEnabled(false)` on the test renderer or `GPUIX_SCROLL_PATCH_OFF=1` turns the bookkeeping, the
count and the translate off. The pixels, boxes and hits are the same either way (`scroll-patch-classifier.test.tsx`, `scroll-patch-translate.test.tsx`). Under `GPUIX_RETAIN_VERIFY=1` a frame that replays rows is built a second time whole and that build is the frame shown, so its rows are not replayed and the next frame is `NotRelocatable`; the cases that need an eligible frame skip there.

**Measured** (the mailbox proxy of ghia-bench on the test renderer: 360 wheel events of 30 px down and 360 up over rows of 72 px with a hover style, `PHASE=scroll A11Y=0 bun mailbox-scroll-hover/profile.tsx`, release addon, no screen reader as a bench run has). Before the refinements (the commit that introduced the classifier): none of the 720 frames eligible; first reasons `Membership` 356, `Hover` 338, `Edited` 26; `held` `Hover` 691, `Membership` 382, `NotRelocatable` 301, `Region` 297, `Edited` 26. Now **328 of 720 are eligible, none mispredicted**; first reasons `Membership` 356, `Edited` 26, `Region` 6, `Hover` 4; `held` `HitboxChain` 691, `Membership` 382, `Hover` 300, `Region` 297 (`Region.top` 150, `Region.bottom` 147), `Edited` 26, `NotRelocatable` 0. What changed:

- **`Hover` was the hitboxes of the children.** The pointer at a fixed point meets another hitbox after almost every 30 px (the avatar, the texts and the row all take it), and only the row has a `hover` style, so what restyles is the pointer changing rows: every 72 px, 300 of the 720 frames. The 691 are `HitboxChain` now and stop nothing.
- **`NotRelocatable` was a run for each root nested in a row that was built.** The frame that brings a row in builds it, and the six `retained` roots inside it (four in the row and two in them) were prepainted inside the recording of the row, where a root keeps no recording of its own; each had a run (`replayed` false, no recording), and the frame shown that built a new row was `NotRelocatable` (300 frames: the row that came in, the last after a scroll down and the first after one up). The row roots themselves always had a movable recording. A root prepainted inside the recording of another is no run now.
- **`Region` is a row that moved more than the overscan since it was recorded.** The overscan is half the viewport (358 of 716 px, `Scroller::overscan`), so a row recorded where it came in has its region used up after 360 px (12 ticks): it is the row at the middle of the viewport (index 5 and 6 of the rows shown when scrolling down, 4 when scrolling up) that the next frame would build late (`retained.relocationMisses.Region`, 0.8 a tick), and once again 360 px later near the edge it leaves by (rows 0 and 1 down, 9 up). 581 row runs in 297 frames, `Region.bottom` for the rows that moved up and `Region.top` for the rows that moved down. Not a row that just came in with too little overscan: a row that traveled farther than the overscan reaches.
- **The three coincide.** Rows come in every 72 px, the pointer meets a new row every 72 px and a row has traveled 360 px (five rows) every 72 px: in this proxy `Membership`, `Hover` and `Region` hold on the same frames, so `Membership` alone is 382 frames, `Membership` or `Hover` 386 (`Hover` alone adds 4, both 296), and `Membership` or `Hover` or `Region` 392. `Region` is the first reason of 6 frames only. With the old `Hover` (`HitboxChain`) the union with `Membership` is all 720. A row coming in at an edge (`Membership`) is what stops the other 382, and a translate that builds that row is the next step.
- With the pointer in the scrollbar gutter of the list (`SCROLL_X=637`, outside the hover-styled boxes of the rows) `Hover` holds for 1 frame, and 323 are eligible: the scrollbar fade makes 9 of the frames `ScrollAnimation` first (19 held).

With the test window's pretend screen reader on (`A11Y` unset) `A11y` holds for all 720 and none is eligible; the rest is the same. Instructions per tick (whole `drawFrame` plus input, two runs each back to back): 11.83M and 11.82M on, 11.58M and 11.63M with `GPUIX_SCROLL_PATCH_OFF=1`: the recording and the classification cost about 0.2M a tick (1.9%), the hit tests of the hover included.

### The translate

`Window::apply_scroll_patch` runs right after the classification, at the top of `Window::draw`, for a frame the classifier called eligible.
It works from the runs of the frame shown, not from its operations moved by the offset: a row of the list was recorded in a region
(its overscan past the list's clip) and a replay puts the recording where the key says and cuts it by the clip around, which is not
what the frame shown cut moved by the offset would be. So for each row it makes again what a replay at the new place makes:

- **The scene.** The operations the recording holds (`PaintRecord::operations`) go through `TranslatedOperations` with the total delta (how
  far from its recording the frame shown had the row plus the scroll, in device pixels, exactly as the relocation of a replay counts it:
  `ListState::scrolled` rounded half up) and the content mask the row was painted under (the list's clip is in it; `ScrollRun::paint_mask`),
  the same iterator `Scene::replay_translated` puts a relocated replay into the scene with, and overwrite the row's range of
  `Scene::paint_operations` (`TranslatedOperations::overwrite`, one operation at a time into its slot: no vector of the translated operations is made). The scene is then made again from the log with the draw orders worked out again (`Scene::rebuild_moved`;
  `rebuild_from_operations` reuses the orders of the log, which holds for a patch that changes how operations paint and not where).
- **The hitboxes.** `Hitbox::relocated` of the recorded hitboxes with the total delta and the prepaint mask, keeping the id and the parent
  of the one in the frame. `hitboxes_changed` and the hit test at the pointer are redone (`mouse_hit_test`), as a draw does; the cursor
  is asked again.
- **The root.** `RetainedState::scrolled_to` sets the delta the root is put at and runs `Relocation::apply` (the handles of text layouts and
  scroll handles, `note_relocated`), and the root's replay listener is told with `RetainedPhase::Scrolled(shift)`. The listener of Ghia
  (`replay_hook`) moves what the root wrote into the registries: `TapeStore::shift`.
- **The list.** The run keeps the new delta and the list's `ListFrame::scrolled` the new position, so the frame after (a translate again, or
  a classification, or a whole frame) is from this one. `ListState`'s own position was set by `scroll()` and the list's scroll listener
  measures from the layout of the frame shown, which a translate does not change.
- **After.** The window is current as after a draw: layout current (`mark_layout_current`), presented, the dirty flag cleared. The
  view that scrolled is taken off the invalidator's queue (`Invalidator::take_views`): left there, the next tick would decline for a pending view (`PatchDecline::PendingView`) and be drawn whole, as the caret's after a scroll was. Under the verifier it stays, for the frame built whole after the translate to take. Ghia follows the hover with the resync the pointer
  frame schedules after a draw (`Window::set_scroll_patch_settled`, run deferred): the hit test is of the frame that moved. The same callback runs the
  sweeps that a painted frame runs from the canvas `observers::frame_sweep` (`onLayout`, `ResizeObserver`, `IntersectionObserver` and the `content-visibility: auto`
  elements, `observers::sweep_after_translate`): a translate paints nothing, so nothing else would read the boxes it moved, and an `IntersectionObserver` on a row
  would be told of a row that came into view with the next frame built whole.

Everything that can decline is checked before anything is written (the plan keeps, for each row, the recording it holds by reference, and the writes are made from it). A row whose state or recording is gone, that hands elements to a stacking context, or
whose operations or hitboxes are not as many as it recorded (a hidden row records none) declines the whole translate
(`applyDeclines`: `Recording`, `Operations`, `Hitboxes`, `Runs`, `Window`), and the frame is built whole in the same draw, with the
prediction still checked afterwards. `Window` is a draw that is a layout pass, measures, or runs inside the dispatch of an input.

**Layout and reads (what was chosen).** A bounds read after a translate does not lay out again and sees the moved rows: the registries
are made complete rather than left to a layout pass, so the window is marked layout-current as after a drawn frame. They are
`Roots`-aware: each registry write remembers the list of its tape it was made into (`tape::owner`) and a list nested in a root is found
through the parents the tapes record, so `TapeStore::shift` moves exactly what a root and the roots nested in it wrote, by the shift and
not to an absolute place: the boxes of `getBoundingClientRect` (the replays that put a root back are further by it; the boxes a frame
wrote for a root it built are moved where they are kept), the matrices of the text registry and the start regions (a press hits the text
where it is), and the replays that have not been read. The paragraphs and the text layouts move by their handles. A registry that gains
a writer has to be shifted here. The alternative (leave the window dirty so that the next read lays out) was not taken: a dirty window is
drawn again whole by the frame loop.

**The thumb** (`Window::paint_scroll_thumb`, zed `window/scroll_patch.rs`; Ghia `scrollbar.rs`). A list's overlay scrollbar paints its thumb
over the rows, and a scroll moves it. The bar paints the thumb through `paint_scroll_thumb(list, quad, plan, moved)`, which paints the quad and
notes, for the frame, the one scene operation it left (a `ScrollThumb`: the operation, the bounds it was painted at, and the owner's two closures),
or that the bar painted none (not shown, or the content fits). A thumb painted under a general transform, or inside the recording of a row, is not
tracked and is `Thumb.track`. Before the frame is built the classifier asks `plan` of each bar of the frame shown, with the list already at its new
position, and `plan` answers with the bounds the thumb goes to, `None` if it does not move, or a `ScrollThumbMiss`, which is a cause of `Thumb`. "Does not move" is against where the thumb is drawn now, which `plan` is given (`ThumbPaint::Quad::bounds`: where the frame shown painted it, or where the last translate put it), and not against where the whole frame painted it: a scroll that brings the thumb back to the whole frame's place after a translate moved it away moves it back.

- `Thumb.alpha`: the bar would be painted at another alpha than the frame shown painted it (a step of the fade, or a hold that has ended). A scroll
  that moves the offset starts the second of the hold again, so a bar that was whole stays whole; one that is held by the pointer or dragged is whole;
  a classic bar is. `plan` runs the prepaint's own arithmetic at the clock's instant (`State::activity`, the same function prepaint uses).
- `Thumb.appear`: the bar was not painted (alpha 0) and the scroll would show it. The first wheel of a gesture after the fade is a whole frame.
- `Thumb.size`: the thumb would be longer or thicker (the pointer's thickening has not ended), or the bar would end or begin to have a thumb.
- `Thumb.track`: the strip, the range or the inset of the bar is not the one painted.

`plan` lays the bar out with `lay_out`, the function prepaint calls, and the rectangle with `bar_rect`, the one paint calls, so a thumb is where the
frame built whole would put it. What the frame shown painted is captured by the closure at paint time (`ShownBar`), not read from the bar's state,
which a pass that only lays out may have advanced since. When the rows are moved, each thumb that moves has its quad made again at the new bounds as
`device_quad` makes it (snapped to the device pixel, placed by the offset the painted one had, so a rect of the same size can be a pixel taller after
the snap, as it is in the build) and written over its operation; the scene is made again once for the rows and the thumb. An operation that is not the
quad the bar noted declines the translate before it writes (`applyDeclines.Thumb`). The hitbox of the bar is its **track**, which does not move
with the thumb, so a scroll moves no hitbox of the bar.

Then `moved` runs for every bar: what the prepaint would have taken from the new position (`move_thumb`): the offset the bar saw, the start of the
hold (`last_active`, so a bar scrolled by a run of translated frames holds a second after the last of them and does not fade at the end of the
second after the first), who holds it, the layout the pointer listeners read (`thumb_start` decides whether a press grabs the thumb or pages), and
the timer for the end of the hold. The timer runs on the clock's instant, since a frame that builds nothing has no `now` of its own.

**The check.** Under the retention verifier (`GPUIX_RETAIN_VERIFY=1`) a translate is followed by the frame built whole at the same instant
with every subtree built (as a patched tick is), and `verify_scroll_patch` compares what the translate made with it: the primitives of the
scene with their draw orders (the thumb is a primitive of it), the frame (the scene's operations, every reachable hitbox by value with its parent, tab stops, the dispatch
tree, cursors) and what Ghia keeps outside the frame (`set_scroll_patch_registries`: the painted boxes, the text elements and the start
regions). A difference is a retention mismatch and fails the tests that run under the verifier. The frame built whole is built from every
subtree, so the rows it records are `direct` and not movable: the frame after is `NotRelocatable`, and a verified run has about one
translate for each wheel after a frame that was not verified.

**Measured** (the mailbox proxy, as above, release addon, three runs of each back to back; instructions per tick are `input + clock + drawFrame` and
include every thread). With the list's scrollbar hidden (`SCROLLBAR=none`): 328 of 720 frames are translates, all 328 patched, none declined, none
mispredicted. Per tick, mean 12.35M, 12.32M and 12.32M with the translate against 12.21M, 12.20M and 12.20M with `GPUIX_SCROLL_PATCH_OFF=1`; the patched
ticks cost 9.10M, 9.04M and 9.03M, the same 328 ticks cost 9.19M drawn whole, and the other 392 ticks (a row comes in, a hover, the first
frame after a commit) 15.07M to 15.16M against 14.75M whole. With the default scrollbar every frame holds `Thumb` (0.96 of them; 0.46 first), none is patched and the mean is
12.43M to 12.48M against 12.23M to 12.25M (the classification, 0.2M). **The translate as built saves almost nothing in this proxy** (about 0.1M
of the 9.2M of an eligible tick): the frames it replaces were already the cheap ones, a replay of the rows with nothing built, and the scene is
made again from the log in both (`rebuild_moved` is most of what a patched `Window::draw` does in a profile of the run, `boundsInserts` 255 a tick, the
same as the replays'); what remains of the tick is the page's present and the JS side. What a translate can save is the scene work, by moving the
primitives of the rows in the typed vectors and keeping the draw orders where the overlaps of the moved bounds with the rest are the ones the log
recorded, and the 15M ticks, which are slice 3's (the row that comes in and the hover). After the scene stopped copying each primitive eight times ([What a replay costs](retention.md#what-a-replay-costs)) the same runs cost 9.77M to 9.80M a tick with the translate, the 328 patched ticks 6.46M and the other ticks 12.5M to 12.6M, 10.00M with the default scrollbar; against 9.75M to 9.77M with `GPUIX_SCROLL_PATCH_OFF=1`, so the translate saves nothing here: both draws make the scene again from the log. The translate had collected the translated operations of every row into a vector and then copied them into the frame (2.2M of a 6.5M patched tick, half of it `memmove`); written straight into their slots they cost 9.30M to 9.33M a tick, the patched ticks 5.37M to 5.42M and the other ticks 12.59M to 12.60M, so the translate now saves about 0.45M a tick against 9.75M to 9.80M with `GPUIX_SCROLL_PATCH_OFF=1`.

**Measured, slice 2b** (the same proxy, `PHASE=scroll A11Y=0`, the default scrollbar, release addon, two runs of each before and after):
before (the build at `cef50f98`): 0 of 720 ticks patched, every frame holds `Thumb` (691 of 720, 328 of them first), mean 9.629M and 9.645M a tick
(scroll down 10.30M, up 8.96M); after: 328 of 720 patched (the same 328 as with `scrollbarWidth: "none"`), none declined, none mispredicted,
`Thumb` held once (`Thumb.appear`, the first wheel, which shows the bar), mean 8.981M and 8.993M (down 9.62M, up 8.34M), the patched ticks
5.01M and 5.06M, the other 392 ticks 12.31M and 12.29M. The mean falls by 0.65M a tick, 6.7%; the patched ticks cost about as much as with the bar
hidden (5.4M in the previous measurement). The 392 ticks that stay whole are the rows coming in at an edge, a hover and the
first wheel after a commit, slice 3's.

**Not in 2b.** The row that comes in at an edge (`Membership`: a layout that builds a row, slice G3 below), and the hover that changes what is under the pointer (`Hover`).

### Rows that come in and leave (slice G3)

A scroll that changes which rows show is a translate as well, when every row that comes in has a measured size (zed `window/scroll_patch.rs`, `elements/list/scroll_patch.rs`, `window/patch_splice.rs`; counters `membershipFrames`, `rowsBuilt`, `rowsRemoved`). gpui moves the rows that stay as before, takes the rows that leave out of the frame (their ranges in every vector), and builds the rows that come in through the builder the list was given, which is `GpuixView::build_virtual_child`: each is laid out as a root of its own, prepainted and painted in a scratch frame at the place the new position gives it, and spliced in at the head or the tail of the rows. A row whose height differs from the one the list measured is `Height` (the rows after it would be somewhere else, as only a layout puts them), and a row that defers a draw, asks for a frame or lies under the pointer declines as `Effects` or `Pointer`. What holds the frame whole is counted by cause under `Membership` in `held`: `Membership.unmeasured` (a row that shows has no size), `.unmeasuredOverdraw` (one in the overdraw has none: a layout would measure it), `.settles` (the list moves its own position or does not fill), `.disjoint` (none of the rows of the frame shown shows), `.noBuilder`. A row that stays can be moved by no more than the overscan its recording was made with (`Region`, half of the list's height); in slices G3b and G3c a scroll by more than that was a whole frame, and since [G3d](#overdraw-measured-and-rows-built-again-slice-g3d) a row that cannot be moved is built where it is, so only a scroll that leaves none of the rows of the frame shown (`Membership.disjoint`) is whole for it.

**A programmatic write takes the same route.** `scrollTo`, `scrollTop = n` and what they are made of (`scroll_write::finish_write`) say that the list scrolled with `Window::note_list_scrolled` (`invalidate_after_scroll`), where only a wheel did before, and notify nothing ([a key in one draw](#a-key-in-one-draw-slice-g3c)). A scroll to a row (`scrollToItem`) is applied by the render that follows and is a whole frame, as is a write while the layout is behind the tree.

**What Ghia keeps for a row.** gpui tells the owner nothing of the rows it takes out, so `TapeStore` works it out (`Rows`, `settle_rows`): `build_virtual_child` notes each row it builds, `RetainedPhase::Scrolled` each row that stayed, and the rows of the frame shown that are in a list that moved and are neither are the ones that left. The classifier's gate folds what was built since the last whole frame into the rows of the frame shown, and a frame built whole starts them over. What a row that left wrote is taken out of the registries (the boxes, the text and start regions, the paragraphs: `Layered::replace` with nothing in its place) and its tape goes; what the rows that came in wrote is at the end of the registries, so the ones that need an order (text, start regions, paragraphs) are put where the rows of the list are, in the order of the list (`Layered::order_by_rows`). Then the page forgets the row (`Retain::forget_left_rows`): its records and dynamic entries, the patch roots and anchors under it and its entry in the rows the next whole frame sweeps. This has to be done before the next frame builds, because a row that came in again with a record would be skipped, and gpui dropped the recording the skip stands for with the row. It runs when the translate is settled (`set_scroll_patch_settled`, before the sweeps that read boxes), before a frame is built, before the classifier asks again, and, under the verifier, when the registries are described. `visibleRange` and `seen_rows` are as they were: the first is reported by the scroll handler of a wheel and by `scrollToItem`, the second is the rows built so far.

**Pinned** by `scroll-patch-membership.test.tsx` (react): a list of 80 rows of different heights, every row measured, scrolled by `scrollTo` and by wheel to bring in 1, 2 and 5 rows at the bottom and at the top, each a membership translate, with the picture, the boxes of every row, what is under points and the clicks on the rows that came in equal to the ones with the translate off; the same steps compared with the frame built whole by the retention verifier, registries included (the frame before each is built whole with nothing replayed, `rebuild`); a row that comes back is built, and one that left has no box. Also in `tape.rs` and `retain.rs`.

**Measured, slice G3b** (release addon, `A11Y=0`, ghia-bench's data). The scroll proxy (`mailbox-scroll-hover/profile.tsx`, `PHASE=scroll`, two runs): median 6.89M and 6.89M, mean 7.68M and 7.63M a tick (before: 6.88M, 7.54M), **0 of 720 ticks are membership translates**, the 328 patched ticks are the ones that were, 3.04M each. Why the others are whole, by the causes that held (a frame can hold several; the first is `reasons`): `Membership.unmeasuredOverdraw` 280 (all of the 280 frames that held `Membership`, 267 of them first), `Region` 296 (`Region.bottom` 146, `Region.top` 150, first for 22), `Hover` 299 (first for 75), `HitboxChain` 690 (stops nothing alone), `Edited` 26. No frame holds `Membership.unmeasured`, `settles`, `disjoint` or `noBuilder`. So the rows that come in are all in the overdraw of the list, which the proxy's list (`estimatedItemHeight`, overdraw 512) has not measured when the scroll gets there, and a translate that does not lay out cannot measure them: **measuring the overdraw rows inside the translate is needed** (zed) for this proxy to gain anything; the rows that show are always measured. After that, `Region` (a row that stays has moved further than its recording's overscan, or was recorded where it no longer is) and the hover that changes (a row restyled under the pointer) are what is left of the 392 whole ticks. The navigate proxy (`mailbox-navigate/profile.tsx`, `A11Y=0`, App, two runs): median 39.5M and 40.4M a key (G2: 38.5M and 39.2M), keys 9 to 30 40.6M in both (about 41M): unchanged, 21 of the 22 keys that scroll the list are `Read:Commit` at the read (the row the selection moves to is not in the frame, see [forced reads](forced-reads.md)), so the draw is a whole frame whose scroll the classifier calls `Other`, and no key reaches the translate. Pinned with the retention verifier in `scroll-patch-membership.test.tsx` with the measured rows of a list of 80, where the steps are all translates.

**Open.** The overdraw rows that are not measured (above); a scroll by more than half the height of the list (the overscan) or of rows recorded long before (`Region`).

### A key in one draw (slice G3c)

One key of ghia-bench's mailbox restyles the row the selection leaves and the one it comes to, swaps the detail for the message of the new row, reads layout (the detail's scroll metrics, a box in the new message) and scrolls the list to the new row. It is one draw, and each part is drawn as the slices before drew it alone:

1. The commit asks for a tick (`Dirty::LayoutPatchable`), and the read prepares the patch of the units and the anchor ([forced reads](forced-reads.md)).
2. The write to the list's offset is **quiet** (`invalidate_after_scroll`): it calls `Window::note_list_scrolled`, which asks for the draw itself and notifies no view, so the prepared patch is not discarded (a notify bumps `update_count`, which discards it). A window that does not classify the frame (`GPUIX_SCROLL_PATCH_OFF`, `setScrollPatchEnabled(false)`) is notified as a `div` scroller is, because nothing else would draw the new offset (`scroll_gate::list_write_is_quiet`).
3. In the draw, gpui finishes the patch first (the restyled rows where they stand, the anchor laid out again), then classifies the scroll from the frame the patch left and translates it, building the row that comes in (`ScrollPatchCounters::composed` counts these; the tick the patch took is not held as `Clock`). A translate that declines leaves the patch, builds the frame whole at the new offset and queues the view the write noted, so the frame shows the offset.

**What the gate says after a patch.** The classifier asks the owner whether the tree is the one the frame shown was built from (`Edited`). A patch drew the tree as it is, so `continue_after_patch` tells the gate the revision (`Retain::note_patched`): the frame shown is the frame of that revision, and a list scroll noted in the draw of the patch, or in a later draw, is classified against it. A change made after the patch is a newer revision and is `Edited` as before. A patch that declined says nothing.

**A restyled row that is not in the frame.** The preview stops a commit that restyles an element no patch root holds (`Commit`). A row of a virtual list that the frame shown does not hold (`Retain::in_row_out_of_frame`: not among the rows built since the last whole frame, which `forget_left_rows` keeps up to date for the rows a translate took out) is not that: there is nothing to repaint, and a scroll that brings it in has the list build it from the tree, which has the new style (its record of an earlier build is keyed by the element's revision, which the restyle moved). A row the frame holds with no root a patch can repaint is still `Commit` and is drawn whole.

**A row a scroll moved is a unit where it stands.** A unit is built where layout puts it, and the registries a patch publishes (boxes, start regions) would put the row back where it was built. `TapeStore::moved` keeps how far from its build each root is (a replay's delta, the shifts of the translates, reset when the root is built again), and the patcher adds it to what it publishes (`GpuixView::moved_since_built`, the nearest root that is moved, walking up the tree). The text layouts of a row are another matter: they are handles that gpui moves with the recording, and a patch that rewrote the recording of a row (zed `RecordingRewrite::relocation`) has them move the handles of the element it built, which the registries and the tape of the row did not hold. So the tape of a repainted row is its recording from then on (`TapeStore::replace_recorded_paint`: the text and start region registries take the new tape's writes in place of the old ones, the boxes are published again under it, so that the translates that follow move them with it), and the patch is compared with it at the distance the row has moved (`same_as_recorded(.., moved)` describes the text layouts of the capture that far on), where a row that was built moved by gpui's handles would read as another text.

**Measured, slice G3c** (release addon, `A11Y=0`, ghia-bench's data, two runs). The navigate proxy (`mailbox-navigate/profile.tsx`): App median of keys 2 to 30 **44.9M and 43.4M** (G3b: 39.5M and 40.4M), keys 2 to 8 32.0M and 33.8M (about 33M), keys 9 to 30 **45.7M and 44.8M** (40.6M). Keys 2 to 30 are all patches (29 of 29 `patchedFrames` and `relayoutPatches`, no `Read:Commit`: it was 21 of 22 of the keys that scroll, and no `UnknownUnit`), and the 22 keys that scroll are **0 composed**: the translate declines each of them (`Membership.unmeasuredOverdraw` 21, `Region.bottom` 17, as in G3b) and the frame is built whole after the patch, so a key that scrolls pays the patch (the read prepares it and the draw finishes it) and the whole frame, where it paid the whole frame and the prepare the scroll discarded. App-noreveal median 26.3M and 26.5M (28.7M and 28.6M; nothing in this slice is aimed at it), `PHASE=scroll` median 6.846M and 6.849M, mean 7.609M and 7.582M (6.89M, 7.65M), `PHASE=hover` row crossings median **4.702M and 4.708M** (4.118M and 4.113M): 0.13M of it is the repainted row's tape taken as its recording (`replace_recorded_paint`, 4.570M and 4.576M with it off), the rest is in the patch of a row that gpui now paints in its region and rewrites the recording of (zed `53b1476e30`). **Where the gain is.** The keys that scroll gain nothing until the translate stops declining: the rows that come in are in the overdraw the list has not measured when the scroll gets there (`Membership.unmeasuredOverdraw`) and the rows that stay were recorded more than half a list away (`Region`), which are the two things the next slice has to remove in zed: measure the overdraw inside the translate, and build a row that no longer fits in the translate instead of holding the frame.

**Pinned** by `navigate-patch.test.tsx` (Solid): five keys of the mailbox shape are each one patch, one translate with membership and no whole frame, with the picture, the boxes, the scroll metrics and the reads equal to those with patching off and with the translate off; a key that does not scroll; a restyled row that is not in the frame (a patch with no unit for it, then built with its new style by the scroll that brings it in); rows in the overdraw; a jump of more than half the list (the patch is made, the frame is whole at the new offset); the rows after a drift past the overscan; a whole frame between keys; a scroll write with no commit with the translate on and off. Under the retention verifier the detail does not change (below).

**Under the verifier, a patch of a unit and of an anchor together reads as a mismatch.** `PatchTrace::in_place_scene` is the scene as the patch wrote it in place, taken before the splice of a relayout patch of the same patch changes the scene, so a patch of a row and of the detail together is compared with a frame that has the splice's effect. Each alone passes, and the picture of the patch equals the frame built whole's (the tests compare it with `captureShownFrame`); it is the check that is stale. The tests keep the detail's message under `GPUIX_RETAIN_VERIFY` (zed would have to leave `in_place_scene` out when a splice follows).

### Overdraw measured and rows built again (slice G3d)

The two things G3c's measurement left holding the translate are done by zed (`32ab4df63c`, `ListState::measure_overdraw` and `Prediction::rebuilds`), and Ghia keeps the bookkeeping of what they do.

**The overdraw is measured inside the draw.** When a list scroll is noted, before the classifier reads the list, gpui measures the rows in the leading and trailing overdraw that have no size, as `layout_items` does (`render_item`, then laid out as a root at the content width, `MinContent`), so the extent, the clamp of a wheel and the thumb are the ones a frame built whole leaves, and `Membership.unmeasuredOverdraw` is held only when a row that shows has no size. The measuring runs `build_virtual_child` for those rows, which does there what a whole frame's `layout_items` does: `seen_rows` and `Retain::begin_row` note the row, the row gets its tape (empty: nothing is painted), and nothing is written into the registries, since the registries are written by paint and the rows are not painted. `visibleRange` is reported by the scroll handler and `scrollToItem` and is not touched. Rows the list measured above the scroll position at another height than it estimated move the position, as they do in a frame built whole, and the translate shifts the rows by it.

**A row that stays and no longer fits is built again.** A row whose recording does not cover the clip at the place the scroll puts it (`Region`, half a list's height from where it was recorded) or meets a clip differently (`Clip`) is taken out and built where it is, as a row that comes in is: `rowsBuilt` counts it, `rowsRebuilt` says how many of those stayed. It is not moved, so `RetainedPhase::Scrolled` is not called for it, and its frame is a membership translate.

**What Ghia keeps for a row built again.** The frame shown holds the row, and the build writes what the row writes a second time, so `TapeStore::row_built` (told by `build_virtual_child`, with whether the build records, which a pass that only lays out does not) says the row is one of the frame shown, built again:

- what the row wrote before is taken out of the registries before the build writes (`text::replace` with nothing in its place: the text, start regions and paragraphs of the lists the old tape stands for and nest, and the boxes of the elements it wrote, which the build writes again as it paints them), so each is in them once;
- the page forgets the row as it forgets a row that left (`Retain::forget_left_rows`: its records, dynamic entries, patch roots and anchors, so the row is built, not skipped with a record of the build gpui drops with the part it takes out, and is entered once among the patch roots and anchors, which a translate does not build the plan of again);
- the tape the build sets (`TapeStore::set`) is the row's from then on, with no distance from its build (`moved`), and the row is among the rows that were built, so `settle_rows` does not take it for one that left and puts what it wrote where its row is in the order of the list (`Layered::order_by_rows`).

A frame that keeps no row in place and builds every row it shows (every kept row missed its region) has moved the rows all the same: `settle_rows` runs for it too (`Rows::rebuilt`), where it used to run only for a frame that moved a row in place, and the rows that left have their writes taken out. Found by the retention verifier with the registries compared: the boxes of the rows that left were still there.

**A patch of a row costs what the registry has read.** `Layered::replace` (a patch that lays an anchor out again, one that repaints a row, and the rows that left) took every replay a registry had not read yet out of its box to look at each write, and asked for each write whether the old roots hold it. It now looks at the replay as a whole, and keeps what `new` writes as a replay at the place of the first old one, and remembers the answer for the owner it just asked about: a hover that crosses two rows of the mailbox 4.70M a crossing, 4.62M. It also works in place: it asks once for each owner it meets, drains the runs of writes the old roots hold (a registry that was not rebuilt since many patches holds thousands of replays, and moving the rest of them into new vectors was most of the call), and puts the replays of `new` where the first run was with one splice, which moves nothing after it when it takes out as many as it puts in. The call is a few microseconds on the mailbox crossing (the registries hold about fifty slots); the change shows in a window that patches for long, where the start region registry grows by a slot for each patched row until a frame is built whole.

**Measured, slice G3d** (release addon, `A11Y=0`, ghia-bench's data, two runs). The navigate proxy (`mailbox-navigate/profile.tsx`): App median of keys 2 to 30 **38.3M and 38.3M** (G3c: 44.9M and 43.4M; G3b: 39.5M and 40.4M), keys 2 to 8 31.8M and 31.4M, keys 9 to 30 **39.0M and 39.2M** (45.7M and 44.8M). 29 of 29 keys are patches (`patchedFrames` and `relayoutPatches`), and of the 22 keys that scroll the list **21 are composed** (a patch and a translate in one draw, 21 membership frames, 42 rows built of which 21 were built again, 21 removed) and one is whole after its patch: the first scroll, which shows the scrollbar thumb (`Thumb.appear`). No key holds `Membership.unmeasuredOverdraw` or `Region`. App-noreveal median 26.3M and 26.5M (G3c: the same). The scroll proxy (`mailbox-scroll-hover/profile.tsx`, `PHASE=scroll`): median **5.557M and 5.554M** (6.846M and 6.849M), mean 7.588M and 7.613M (7.609M and 7.582M): 396 of 720 ticks are translates, 43 of them with membership (0 in G3b) that built 58 rows, 43 of them again, and took out 14; the 324 frames built whole are held by the `Hover` of the row under the pointer for 302 (the largest cause now), by `Membership.unmeasuredOverdraw` for 14 (the first scroll over rows the list has not laid out, which measuring the overdraw cannot do while a row that shows is unmeasured) and by `Edited` for 29. `PHASE=hover` row crossings median **4.617M and 4.615M** (4.702M and 4.708M; G3b 4.118M and 4.113M).

**Pinned** by `scroll-patch-membership.test.tsx` (react): a list whose rows are not measured, scrolled by `scrollTo` and by wheel through four of its heights and back in steps of two thirds of its height (more than a row recorded where it showed can be moved by): each step is a membership translate with rows built, some of them again, no frame built whole, and the picture, the boxes (text included), what is under points and the clicks on every row that shows are what the translate off gives; the same steps compared with the frame built whole by the retention verifier with the registries (every second step, the one after a compared frame being built whole), where the boxes of the rows that left were found stale. `navigate-patch.test.tsx` (Solid): the fifth key of the drift case builds a row again in the same translate and is no longer a frame built whole. `scroll-patch-classifier.test.tsx`: fourteen wheels of 5 build rows again and hold the frame for no `Region`. `tape.rs`: a row built again is in the registries once, a frame that kept no row takes out the rows that left, a pass that only lays out builds nothing again.

**Open.** A wheel after a programmatic write that was a translate drops the write (zed `list.rs`, the wheel handler keeps `scroll_top` from the last frame built whole). The hover held 302 of the 720 ticks of the scroll proxy; slice G3e below removes it.

### Under a wheel (slice G3e)

A wheel over a list moves the rows under a pointer that stays, so the row under it changes every row height. When the hover of those rows
only paints ([Which hovers paint only](#which-hovers-paint-only)) it is not a reason to draw the page again: `hover_would_matter` says yes
only for a hover that is a frame built whole (`Restyle::Whole`) or that a listener hears, so `Hover` no longer holds the translate. It held
302 of the 720 ticks of the scroll proxy.

- **Who paints the hover.** The frame that translates the rows has the hover of the frame before. The resync that
  `Window::set_scroll_patch_settled` runs after it (`scroll_settle`: the pointer frame of the frame shown) finds the row the pointer is
  over now and asks for a tick, which the draw after takes as any hover that paints: `Retain::preview` names the row that lost the
  hover and the row that got it, `Window::patch_blocker` accepts them (a row a translate moved keeps its unit, and a patch of it is painted
  in its region and rewrites its recording), and gpui writes the two rows' primitives where the translate left them. The wheel's draw and
  the hover's are two frames, as the hover of a frame built whole is (the hover state is the dispatcher's and is updated after the draw):
  `scroll-patch-hover.test.tsx` draws two frames a wheel, as a window's second frame is the tick the first asked for. A test renderer that
  draws one frame per input (the proxy's tick) leaves the hover where it was while the wheel goes on, with the translate on or off; the
  first frame without a wheel repaints it.
- **`Hover:Relocated` is a row a frame built whole replayed.** A frame built whole after a scroll replays the rows from the recordings
  made where they were, with a delta, and they are not patch sources until something builds them again: the hover of one is declined as
  `Relocated`, a frame built whole, which records the two rows where they stand. A translate does not do that: it keeps the units of the
  rows it moves, so the hover after a translate is a patch. `scroll-patch-hover.test.tsx` builds every row where it stands before the
  wheel steps (`rebuild`, as `scroll-patch-membership.test.tsx` does).
- **What tells the causes of `Hover` apart.** gpui holds `Hover` for a pointer that is not where the frame shown had it as well as for a
  hit chain the owner says matters; `scrollPatch.hoverAsked` counts the frames the owner was asked about and `hoverMatters` those it said
  yes to, so `held.Hover - hoverMatters` is the wheels whose position differs from the shown mouse. The scroll proxy has one (the first),
  and `hoverMatters` 0.
- **A fully clipped primitive in a `div` scroller (open, zed).** Under `GPUIX_RETAIN_VERIFY` the three wheel and `scrollTo` cases of
  `retained-scroll.test.tsx` (a `<div>` scroller of rows with an avatar and two texts, not a list) report a patched frame that differs from
  the one built whole by a primitive that the patch has and the frame drops because it is clipped away: the avatar's quad at y -48 (40 by 40,
  under the scroller's content mask, which starts at 10) or a glyph at y -19, of a row the scroll left partly above the clip and that the
  pointer entered or left. The pictures are equal. It reproduces with rows of a `div` with a `hover` background, a 40 by 40 `div` and a
  `text`, in a `div` scroller of height 300 with `overflowY: auto`, scrolled by `scrollTo(top)` to 224 and 230 with the pointer moved into the top row and
  out of it, the verifier on; the same rows in a `<virtual-list>` do not differ. Nothing of Ghia's writes a primitive. A patch of a row painted in its
  region puts what it painted into the scene with `Scene::replay_translated` (`scene.rs`, `TranslatedOperations::translate_primitive`), which cuts the
  primitive's content mask by the clip but does not leave out a primitive that is wholly under the clip then, as `Scene::place` does for one that
  a frame built whole paints. Not fixed here: the engine is zed's.

**Measured, slice G3e** (release addon, `A11Y=0`, ghia-bench's data, two runs; zed at 6231b52b34). The scroll proxy
(`mailbox-scroll-hover/profile.tsx`, `PHASE=scroll`): median **4.369M and 4.365M** (5.557M and 5.554M), mean 7.148M and 7.134M (7.588M and 7.613M);
**693 of 720 ticks are translates** (396), 339 of them with membership (43; 841 rows built); the 27 frames built whole are `Edited` for 26 and
the `Hover` of the pointer's first position for 1 (`Membership.unmeasuredOverdraw` 13 and `Thumb.appear` 1 are held by these as well),
`HitboxChain` held 719 (stops nothing), `hoverAsked` 719 and `hoverMatters` 0. The mean moves less than the median because the hover
patches that follow a crossing are not in the proxy's ticks, which draw one frame (see above). `PHASE=hover` row crossings median
**4.595M and 4.597M** (4.617M and 4.615M; 18 of 18 patched). The navigate proxy: App median of keys 2 to 30 38.5M and 38.6M (38.3M and 38.3M),
keys 2 to 8 31.8M and 31.3M, keys 9 to 30 39.1M and 39.25M, 21 of 22 scrolling keys composed; App-noreveal 26.4M and 25.7M (26.3M and 26.5M): the
navigate proxy has no wheel, and the zed bump does not move it.

**Pinned** by `scroll-patch-hover.test.tsx` (react): rows of 40 with a hover background in a view of 100, every row measured and built where it
stands, wheel steps of 15 and 5 under a still pointer across four row borders: every step is a translate, `held.Hover` and `hoverMatters` are 0,
`hoverAsked` covers the crossings, each crossing is one patch (`patchedFrames`), no frame is built whole (`getPaintedFrameCount`), and the picture and
the boxes after each step are equal with the translate off; the row under the pointer and `getElementsAt` are equal too (asking for them draws a
frame built whole, so a run of its own); rows with a `pointerenter` listener are a frame built whole for the crossing; and under the retention
verifier the steps are translates compared with a build.

### A row of a list is recorded for its travel (slice G4a)

A row was recorded with the overscan of any scroller, half the height of the list, so a row that travelled further than that since the
frame that recorded it did not fit (`Region`: the region it was recorded in, moved by the scroll, no longer covers the clip) and was built
again where it is, in the translate (`rowsRebuilt`, [slice G3d](#overdraw-measured-and-rows-built-again-slice-g3d)): one row for each row that
came in, 3.6M instructions or so a row and a layout pass of the row. `Scroller::of_list` now records a row for the travel of a row that shows.
A row is recorded when the list builds it, up to the list's overdraw outside the clip, and is replayed until it leaves across the
viewport, so it travels the overdraw, the viewport and its own height; the box of a row that has never painted is not known, and a root is
at most `ROOT_VIEWPORTS` (2) viewports tall, so the overscan of a row is three heights of the list plus the overdraw (`Scroller::of_list`,
`overdraw` read from the list's config where the row is built). A scroller that is no list keeps half a viewport (`OVERSCAN_VIEWPORTS`).

The region is bigger, not the row: what a recording holds is the box of the row cut by the region, and a row the list builds is within
the overdraw of the clip, so every row is recorded whole as it was when the overscan was bigger than the distance of the row from the
clip. The overdraw is 512 by default, which is more than the 358 of the old overscan of the proxy, so a row 358 to 512 px outside the clip
was culled by its parents (`cull_outset` plus the overscan, `Retained::cull_outset`) and is now prepainted and painted in its region
when the list builds it: once, where it was built again when it came in. What a frame built whole emits does not change, since placing
the recording drops what the clip around cuts away entirely (`Scene::place`).

**Measured** (release addon, `A11Y=0`, ghia-bench's data, two runs). The navigate proxy (`mailbox-navigate/profile.tsx`): App median of keys 2 to 30
**36.9M and 36.1M** (G3e: 38.5M and 38.6M), keys 2 to 8 33.9M and 31.6M, keys 9 to 30 38.9M and 37.3M; a key that scrolls builds 1 row
(`rowsBuilt` 1, 21 of 22 composed) and builds none again (`rowsRebuilt` 0, it was 1), and no key counts a `Region` miss. App-allstatic (only
the list scrolls) 9.6M and 9.6M (about 12.5M), App-noreveal 26.3M and 26.4M. The scroll proxy (`PHASE=scroll`): median 4.358M and 4.223M
(4.369M and 4.365M), mean **5.511M and 5.520M** (7.148M and 7.134M): the translates are the same 693 of 720 ticks, and what they cost less is the rows
that came in at a tick; no row is built again. `PHASE=hover` row crossings 4.598M and 4.604M (4.595M and 4.597M).

**Pinned** by `scroll-patch-membership.test.tsx` (steps of two thirds of the list's height through four heights and back, by `scrollTo` and by
wheel): rows come in (`rowsBuilt` above 0), `rowsRebuilt` is 0 and `relocationMisses.Region` is 0, and the picture, the boxes and the clicks are
what the translate off gives, with the retention verifier too; `scroll-patch-classifier.test.tsx`: a hundred wheels of 5 (five heights of the
list) build no row again and hold the frame for no `Region`; `navigate-patch.test.tsx`: the fifth key, which moved the rows by more than half
the list, builds a row that comes in and none again. `retain.rs`: `Scroller::of_list` records for the overdraw and three heights of the list
(the window's before the first layout). A row built again for `Clip` or `Place` is still built where it is, and `rowsRebuilt` counts it: gpui's
tests pin that.

### The work of a restyle and of a build, per element (slice G4c)

A profile of a navigate key (a restyle of two rows, a swap of the detail and a scroll of the list) found cost in the per-element code that no
patch changes, and three pieces of it were the same question asked again of the same answer:

- **A restyle that only paints is judged once for its styles.** `RetainedTree::set_style` asks whether a restyle is one a patch can follow
  (`hover_paint::restyle_paints_strictly`): it resolves each style under every state either declares and compares the two, and the compare
  parses the border shorthands of every side again. The answer is a function of the two styles and of one thing below the element (a colour
  that changes is inherited, and a transition below would start from the old one), so `restyle_paints_of` says what the styles say (`Paints`:
  no, yes, or yes if no element below declares a transition) and `StyleMemo` (`style_memo.rs`) keeps that by the addresses of the two interned
  styles. The address names the content because a shared style is not changed; the memo holds `Weak` references so the address is not given to
  another style while the entry lives and `StyleTable::sweep` still frees the styles, and it has 512 entries. The tree part is asked each time.
- **The scan of a subtree for a patch root** (`Retain::scan_patch_root`, once per revision of a subtree) asked `declares_paint_hover` of every
  element in it, which is the same two resolutions and border parses: `paint_hover_of` is the style part, kept the same way
  (`Retain::hover_scans`).
- **`TapeStore::same_as_recorded`** (every patch of a row asks it, to know the patch only repainted) rendered every write of both tapes through
  `format!` and `Debug` and compared the strings. It compares the writes by what they hold: the box without its matrix, culled and facing
  flags, a text by key, position, text, group, line and cell, a start region by its box, a logged text, a measurement with the parent content each
  reads now. A paragraph write has no comparison of its own and is still compared by its words. Floats are compared by `==`, so a box at -0.0
  against one at 0.0 is the same where the words differed; they paint the same. The words stay under `cfg(test)` as the oracle.

The profile's other costs of `build_element` (a `StyleDesc` clone and drop about 7%, allocation 11%) were looked at and not changed: the
style derivations it reads (a container fold, `var()` resolution, content visibility, the underline offset, a row's `lift_absorbed`) clone
only for a style that they change, and no clone of a style that stays the same was found. `getBuildCounters().styleDescClones` counts them.

**Measured** (release addon, `A11Y=0`, ghia-bench's data, two runs, alternating with the build before the slice, which is the zed bump alone: the
snap cache of zed `2b2da134c4` is in both). The navigate proxy (`mailbox-navigate/profile.tsx`, 51 keys), median of keys 2 to 30 and of keys 10 to
50 (the proxy app's own windowing runs out of mounted rows after key 52, so the warm window ends before it): App **32.0M and 32.1M** (30.8M and
30.8M) against 33.6M and 33.2M (32.0M and 31.5M) before; App-detailstatic 14.0M and 14.2M (13.7M) against 15.4M and 15.3M (15.0M and 14.9M);
App-noreveal 22.4M and 22.4M (19.3M) against 23.7M and 22.8M (19.7M); App-allstatic 9.4M and 9.5M against 9.6M and 9.6M (nothing restyles).
Against G4a the zed bump alone took App from 36.5M to 33.4M and App-noreveal from 26.4M to 23.2M: the snap cache computes the marks of a text
once for its widths, 15 times a key (`snapComputations`, 9 to 19) where a layout takes them 39 times (`snapCacheHits`, 21 to 52; 72% of the
wrapped layouts that need marks), and the lists of line ends 9 times (`endReshapeComputations`, 5 to 12). By piece, two runs each of builds with the commits
up to it, App and App-detailstatic: the tape comparison took 0.35M and 0.65M, the restyle memo 0.75M and 0.25M, the scan memo 0.25M and
0.35M. The hover row crossings (`PHASE=hover`) are **3.655M and 3.664M** against 4.586M and 4.601M, all of it the tape comparison (3.670M with
that commit alone): a patch of a row asks `same_as_recorded` for each row it repaints. The scroll proxy (`PHASE=scroll`) median 4.325M and
4.343M against 4.345M and 4.336M, mean 5.479M and 5.465M against 5.515M and 5.516M: nothing in the slice is on the path of a translate.

**Pinned** by `hover_paint.rs` (the memo's answers for twelve styles against each other, above a child with and without a transition, twice, equal
those of `restyle_paints_strictly` and `declares_paint_hover`), `style_memo.rs` (an answer is computed once for a style and for an ordered pair, a
memo that is full lets go of the styles nothing holds) and `tape.rs` (nine variants of a root compared by what they hold and by their words, at
two moves of the text layout, give the same answer for every pair).

### A row the list does not have to build to measure (slice G4e)

A list scroll that brings a row into the overdraw measured it first: the list built the row and laid it out in a scratch frame, threw the
frame away, and built the row again when it showed (a profile of the allstatic key put 37% of it, 3.3M instructions, in `measure_overdraw`).
A row whose root style fixes its border box needs no measuring, so the owner tells the list
(`ListState::set_exact_item_size`, [scroll.md](scroll.md#virtual-lists), `list_sizes.rs`): the overdraw of a scroll is measured from the
declarations with no scratch frame, and a row that shows is checked against what it was told (`scrollPatch.declarationMismatches`, 0 in every
test and measurement). `scrollPatch.rowsMeasuredByLayout` and `rowsMeasuredByDeclaration` count the rows measured each way. The proxies'
rows (`position: relative`, `height: 72`, a bottom border, a paint-only hover) are declared, and none of their rows is measured by layout.

The declarations are read from the tree when a list's rows change, and only for the rows whose revision changed: a first version read all 60
rows at every restyle of two, which cost App-noreveal 1M a key, and costs nothing now (22.3M and 22.2M against 22.5M and 22.6M with the
switch off).

**Measured** (release addon, `A11Y=0`, ghia-bench's data, two runs each, back to back with `GPUIX_LIST_SIZES_OFF=1`, which is the build
before the slice with the zed bump). The navigate proxy (`mailbox-navigate/profile.tsx`, 51 keys), median of keys 2 to 30 (10 to 50): App
**28.1M and 28.8M** (26.8M and 26.8M) against 28.8M and 30.1M (27.6M and 27.6M) off, and 32.0M (30.8M) at G4c, the rest of that being the zed
bump (the sort that moves each item once, the scene made once for a patch and a translate, `deferredSceneRebuilds` 1 a key that scrolls);
App-allstatic **8.6M and 8.6M** (8.7M) against 9.4M and 9.4M; App-noreveal 22.3M and 22.2M (19.2M and 19.3M), unchanged by the slice (22.5M and
22.6M off). Per key `rowsMeasuredByDeclaration` is 1 (0 to 9, 53 over the 51 keys, the nine of the first draw), `rowsMeasuredByLayout`
is 0 on every key where it was 1 (0 to 9, 53) with the switch off. The scroll proxy (`PHASE=scroll`) median **3.185M and 3.182M** against
4.270M and 4.213M off and 4.33M at G4c, mean 5.008M and 5.017M against 5.406M and 5.398M (5.47M); the membership translates (333 of 720
ticks, 286 rows built) cost a median of 5.58M against 6.56M. `PHASE=hover` row crossings 3.654M and 3.653M against 3.663M and 3.660M
(3.66M): they build no row that is not shown.

The saving is the scratch layout and not the shaping: a text laid out in the scratch frame is a hit in the line layout cache when the row
is built where it shows, so the shaping the declaration avoids in the scratch frame is paid by the row that shows, and a key that brings one
row in saves about 0.8M, not the 3.3M the scratch frame took (App-allstatic per key: `elementsBuilt` 9 against 18 and `layout.nodesCreated` 24
against 24 to 50 on the keys that bring a row in, `layout.shapes` 5 against 5, 210 over the keys against 205).

**Pinned** by `list-exact-sizes.test.tsx` (react): 34 row styles (a height in px, with a position, a width, padding, borders of 1, 3, 0.4, 1.5
and 2.5 px, a height below its padding or border, margins, a flex and a grid container with and without a width, a fractional height, a hover
and a transition that paint) are laid out at the size they declare (`declarationMismatches` 0, no row measured by layout) and are the
same list as one that is not told (boxes, scroll extent, picture with the thumb, after wheels and `scrollTo`s down and back); styles that
leave the box to layout (no height, `%`, `em`, `calc()`, min and max sizes, an aspect ratio, an absolute position, a hover that pads, a
transition of the height) declare nothing; a list of both measures by layout only the rows that are not told; 120 rows of which most are
never shown are not built to be measured (`elementsBuilt` below that of the list not told); a windowed list; a row whose height changes.
`scroll-patch-classifier.test.tsx`: a row never measured is a translate when its style declares its size and `Membership.unmeasured` when
it does not. The unit tests of `list_sizes.rs` pin each condition of the declaration, and the zed tests (`exact_sizes`) the list.

### The window of a list moves under keys (slice G4d)

The navigate proxy windows its rows from `onVisibleRange` (`WINDOW` 60, `windowStart` from the start index), and `scrollTo` reported no range
(see [scroll.md](scroll.md)), so its window stayed at the first 60 rows and the list was blank from key 52. A write now reports the range, the
window moves every ten rows, and the rows past it are mounted and painted (`SHOT_DIR=dir SHOT_KEYS=52,70,120` of the proxy writes the frame shown
after those keys; the list shows the selected row at keys 52, 70 and 120).

**Measured** (release addon, `A11Y=0`, ghia-bench's data, two runs, `KEYS=120`). Median of keys 2 to 30 (10 to 50): App **29.5M and 28.2M**
(28.7M and 28.0M) against 28.1M and 28.8M (26.8M and 26.8M) at G4e, the window moving at key 44 now and at 54, 64, 74, 84 and 94 after it
(a move is a key of 44M to 66M against 20M to 30M: the rows of the new window are mounted and the old ones unmounted). The 69 keys 52 to 120,
which were blank before: median **25.6M and 25.2M**, mean 28.6M and 28.6M. The scroll proxy (`PHASE=scroll`), which wheels, reports the same events as before and is
median 3.171M and 3.192M, mean 5.004M and 5.018M (3.185M and 3.182M, 5.008M and 5.017M).

## Limits

- **A tick that gpui or gpuix cannot patch is a full frame, and says why.** A subtree of more than 256 elements is built whole
  (`unitsOversized`, `TooLarge`). A `position: fixed` element is no unit (`Excluded:fixed`), where an absolute one is. A loop on an
  element that holds an absolute box against a block outside it is `Escapes`. A scroll animation, a scrollbar fade (not its hold), a layout-only
  pass since the last full frame, the pointer, focus, a scroll, a measurement or any change that is not the clock (a hover or a
  commit that only paints is answered by a patch, see [Commit patches](#commit-patches)) make the tick a
  full frame (`getPatchCounters().unpatchable`). A scroll animation is always asked for as `request_animation_frame` and drawn
  whole. The run of an `opacity` or transform animation starts and ends with a whole frame.
- **A hover frame still scales with the roots it replays**, so culled cards are not free there (see above and
  [retention.md](retention.md)).
- **Layout-driving loops are full frames** ([units](#units)).
- **The glyph `d` morph** costs a parse, a raster and a texture a tick; the tape is compared through strings. Not changed ([what
  a patched tick still walks](#what-a-patched-tick-still-walks)).
- **An `<svg>` whose paint would start a job** is whole for one frame ([`<svg>`](#an-svg-is-culled-like-a-box)).
- **Open, `Unsteady` from FF's showcase.** It stopped reproducing with the same release addon and no change to the build or the page: first `Unsteady` 68 a second, then `Outside` 64 a second. The cause was not found (a different display state of the machine was suspected and not shown). The `<svg>` with no area is the class that reproduces `Unsteady` in a test and is fixed and pinned ([`<svg>` waiting for its raster](#an-svg-waiting-for-its-raster-and-motion-under-display-none)), but it is not proven to be the showcase's cause.
- **Open, FF's skipped ThinkingIndicator cards.** FF reported cards that were skipped and hold a ThinkingIndicator (a `motion.path` `d` loop and a CSS colour loop per letter) taking an idle page from 4 to 6% CPU and 0 whole frames a second to 20 to 23% and about 72 a second. It was not reproduced in the test renderer ([skipped content](#skipped-content-97)); it needs a measurement in a real window.
- **Open, iteration listeners.** They are asked again when the tree's revision moves, so a page that commits at every frame walks the
  path of each iterating dormant element at each.

## Breaking changes

A paint-only animation on content a frame walked culled does not build or draw: its clock, its events and `getAnimations()` move at
ticks that present nothing, as Chrome runs the animations of content it does not show. `animationiteration` and the other events
come at the frames a per-frame tick gives them, and `getAnimations()` reads the instant of the tick.

## Tests

- `scroll-patch-classifier.test.tsx` (react): rows of 40 in a view of 100 that take no pointer: a wheel of 5 twice is two eligible
  frames and no misprediction; one of 25 that brings the fourth row in is a `Membership`; rows with a hover style, or a
  `pointerenter` listener, and the pointer at 38 crossing into the next row is a `Hover` and `hoverOnly` for the listener and an eligible frame (`HitboxChain` held) for the hover style; rows that take the pointer and
  restyle nothing and have no listener are an eligible frame with `HitboxChain` held; a pointer that stays in its row is not a hover
  change; a hundred wheels of 5 build no row again (`rowsRebuilt` 0) and hold the frame for no `Region`; nothing is counted with the classifier off; the boxes, what is under a point and the
  picture after each of seven wheel events are equal with it on and off, for the four kinds of rows.
  gpui `window/scroll_patch_tests.rs`: each reason on a list of retained rows (a fraction, a row coming in, a row leaving, a pointer
  that stays and one that crosses, no overscan for the region and its edge, rows that are not relocatable, a root inside a row that was
  built, the owner's gate, no owner, a screen reader, another view notified, the focus), the owner's answer for the hover (asked with
  the chain before and the chain after, not asked when the hitboxes under the pointer are the same, `Hover` when it says yes and an
  eligible frame when it says no, a pointer that moved), `mispredicted` zero, nothing counted when off, and the scene after four wheel
  events equal with the classifier on and off. Native `events/dispatcher.rs`: `hover_would_matter` agrees with the restyle and the events
  of the move it asks about, for hover, `:has(:hover)` and boundary-event listeners on the element, an ancestor and `window`, and a
  captured pointer.
- `scroll-patch-translate.test.tsx` (react): a virtual list with no scrollbar and rows narrower than it, wheeled by fractions of a row with the
  pointer in the gutter: some frames are translates (`patched` above 0, none mispredicted, `eligible` is `patched` plus `applyDeclines`) and
  the picture, the boxes of the rows, what is under four points and the cursor after every wheel equal the same wheels with
  `setScrollPatchEnabled(false)`; the pointer in a row that has a hover style, kept and then crossed into the next; a commit between the
  wheels is a whole frame (`Edited`) and a translate again after it, equal to the control; a read of the box of a row after a translate
  says it moved without drawing. gpui `window/scroll_patch_tests.rs`: the frames of fractions of a row are the frames built whole (the
  scene with its draw orders, the operations, every hitbox by value, the hit test), also with a root nested in each row, interleaved with
  frames built whole, and with the pointer in a row; a translate that cannot be made declines (`Hitboxes`) and the frame is the one built
  whole; `Thumb` said by the owner; the verifier passes a translate and calls a difference in the registries a mismatch.
- `scroll-patch-thumb.test.tsx` (react): a virtual list with the scrollbar the system draws, wheeled by pixels and fractions of a row: some frames are
  translates, none mispredicted, no `Thumb` after the wheel that shows the bar, and the picture after each wheel (the thumb is in it) equals the
  same wheels with the translate off; 70 ticks of a pixel at a vsync each (1.1 s) then the second of the hold after the last, and the fade, equal
  the control at every step, which pins that a translated frame starts the hold again (it fails if `move_thumb` leaves `last_active` alone); the
  first wheel after the fade is `Thumb.appear` and drawn whole, and the wheel after it is a translate again; wheels while the bar fades equal the
  control. Under the verifier the translates of the first case are compared with the frame built whole and 0 mismatches are asserted.
  gpui `window/scroll_patch_tests.rs`: a list with a bar whose thumb the test moves (`Bar`): the frames of nine wheels with the thumb are the frames
  built whole (the scene with the thumb's quad, the operations, the hitboxes), the bar is told once for each frame that moved the rows, each cause
  (`alpha`, `size`, `track`, and `appear` for a bar not painted) holds only its own and draws whole without telling the bar, a thumb painted under a
  rotation is `track`, an operation that is not the thumb's quad declines (`applyDeclines.Thumb`) before anything is written, the verifier passes a
  moved thumb and calls one that was put elsewhere than the bar paints it a mismatch.
  A scroll that brings the thumb back to where the frame shown painted it moves it back (`brings_the_thumb_back_to_where_the_frame_shown_painted_it`: it
  fails when `plan` compares against the whole frame's thumb), and `scroll-patch-thumb.test.tsx` has the same after a fade: the wheel that shows the bar is
  drawn whole, then 0 and back, with the picture of the control at each step.
- `scroll-patch-observers.test.tsx` (react): an `IntersectionObserver` with thresholds on the third row of a short list, wheeled by 5 px in steps and back, is told the
  entries of the control with the translate off, in frames that are translates (`patched` at least 6; it fails without the sweep after a translate). `onLayout` and
  `ResizeObserver` have nothing to read in a translate (no size changes) and an `auto` element cannot change its answer by a scroll that a recording of a row allows, so
  they have no case.
- `scroll-patch-clock.test.tsx` also has the tick of a caret after a translate: with no wheel event in its draw it is a patch (`patchedFrames` goes up), where it declined `PendingView`
  with the list's view left queued. gpui `window/scroll_patch_tests.rs`: `a_translate_takes_the_view_the_scroll_notified_off_the_queue` (fails without the take).
- Native `retain.rs`: `sources_changed` (what the scroll gate asks of the sources) is false for a frame that only time and a hover chain moved, and true for a press (the
  active chain), the focus, a selection, a measurement, a link, a command, a relevance, a hover restyled by paint, a custom element, a scroller that is no list and a
  frame never built. There is no react test of the gate itself: a press and a double click are declined by the other checks too (the notify of another view, the
  tree), and the keyboard does not select the text of the page, so no input of the test renderer changes only these sources; the translate tests passing (`patched` above 0) show
  the gate does not decline what it should not.
- `scroll-patch-clock.test.tsx` (react): a wheel in the draw of a tick (a transition of a box beside the list, the blink of the caret of an input beside it) is
  a whole frame, `reasons.Clock` counts them, the picture after each step and the `transitionend` are those of the control with the translate off, and the
  translates resume once the transition has ended. gpui `window/scroll_patch_tests.rs`: a `request_tick` in the draw of a wheel is `Clock` and the next wheel
  without one is a translate; the owner's `Clock` is the only reason.
- Transforms in three dimensions patch every tick with no decline of either kind (`getPatchCounters`): `transform-css-patch.test.tsx` for a transition of `rotateY` under a perspective, an animation of 3D lists that do not pair, of the depth of `transform-origin` around a rotation, and of the `perspective` and `perspective-origin` of the parent; `motion-transform.test.tsx` for a Motion tween of `rotateY` whose card hides the face that turns away on the patched ticks (`faces_away` is published with the box, not compared by the tape; [paint-and-transforms.md](paint-and-transforms.md#retention-and-patched-ticks)).
- `animation-frame-work.test.tsx`: at 500 and 5000 nodes every loop kind (keyframes colour, native `motion` colour, colour
  transition, svg stroke dash, `motion` and keyframes opacity, the colour loop of a relative box with and without a `z-index`, loops
  beside an `<input>`, `textarea`, focused input, selection, `<code>`, `<markdown>` and `<diff>`, loops under `relative`,
  `absolute` and `opacity < 1` wrappers and on absolute elements, beside an `<svg>` of no area or waiting for a job) does the same
  work per tick (elements built, prepainted, painted, primitives, retained and layout counters equal) with `patchedFrames` equal to
  the ticks, also with a screen reader on, and the picture equals the frame built whole at the same instant and patching off.
  Hover and a React commit draw a full frame and patching resumes; `animationiteration` comes once per iteration and `currentTime`
  moves per tick across 300 patched ticks; loops through exactly 1 and exactly 0 patch every tick. A `width` loop is drawn whole
  and says `LayoutAnimation`; a fixed text counts `Excluded:fixed`; a loop on an element that holds an absolute box against an outside
  block counts `Escapes`; each refusal on a page with no unit; the containing block moved by a click mid-loop is followed. The
  focused input is built 0 times across 20 ticks within a phase and once across a change of phase; one scrolled out of its scroller
  asks for no frame in 2 s of clock, takes the text typed there and blinks again when scrolled back. A loop beside 400 resting
  `motion.div`s syncs one motion a tick (401 after a resize, then one again), one bound to a colour beside 400 resting values samples
  one value a tick, a colour loop beside 120 boxes in view works out the orders of the loop alone. Motion-value cases: tween,
  spring and paused-then-played tween equal the frame built whole up to the tick the value stops being a source; a write to a
  scroller's colour or to a width is drawn whole. The tests that screenshot between ticks look at every third tick, since the tick
  after a screenshot is whole.
- `layout-idle-patches.test.tsx` (react) and the solid file of the same name: a looping opacity animation beside a box with no `layout`,
  `layout`, `layout="position"` or `layout="size"` (200 bars of 80 by 4 pixels, the page where nothing can be skipped) has 150 of 150
  ticks patched and none whole while the box rests, 30 of 30 whole while a 1 s glide runs (the box a half of the way at 30 ticks, and
  `onLayoutAnimationStart` once), and the ticks patch again once `onLayoutAnimationComplete` has been sent (at most 3 whole of 150); a glide
  after it starts from where the box is shown, also when it retargets one half way. Red before #117 for the three `layout` variants (150 whole, `NoFrame`). `retain.rs`: a layout box leaves a tick alone, `Gliding` says no, a page with a loop and
  nothing to skip is recorded at every frame; `layout_flip.rs`: `needs_frames` from the commit that moved a box until its events are
  sent, and for a box with `dragOffset` only while it is held or its values were written. `examples/layout-idle.perf.test.tsx` (`bun run test:perf:layout-idle`) is the guard; its `drag` variant is patched at every tick of the loop, and whole at every tick while the box is held (0 of 150 patched), patched again after the release.
- `layout-drag-patches.test.tsx` (react): a `Reorder.Item` beside a loop over 200 bars: 150 of 150 ticks patched before the press, none patched while it is held (also between moves), the glide back whole, patched again after; the picture, the boxes, the text and the accessibility tree equal a build at the press, a move, ticks while held, the release, the glide and the rest, also under `GPUIX_RETAIN_VERIFY=1`.
- `offscreen-animation-work.test.tsx`: 200 cards with a stroke loop on a small and on a more than 4 KB `<svg>`, below the window
  and clipped; iterations and ends of five loops of other lengths come at the ticks of a shown one; a card scrolled into view has
  the pixels of a build with retention off; the dormant-tick, wake and skipped-content counts above. "A native spring that nobody sees" and "a spring
  motion value that nobody sees" (culled and skipped places; 20 cards): completion in the tick it has in view with at most two
  dormant ticks and at most one painted frame, none at all with no listener, a tick a frame with a `change` listener, the value of
  the current instant when revealed mid-run, a follower of a loop sampled each tick. "A frame built whole by a hover beside native
  motions that rest" (1 motion synced, 2 with a `whileHover`) and "the rows of a virtual list built beside native motions that
  rest" (the rows sync their own motions, not the page's). Runs on the debug addon (it used to abort at its first motion case).
- `retained-opacity-states.test.tsx` (36 cases): one card of a replaying page goes between 1 and 0.5, 0.5 and 1, and 1 and 0 through
  each state style and a React write, with no transition and with `opacity 240ms linear` stepped on the test clock, and equals
  retention off at every step, plain and under `GPUIX_RETAIN_VERIFY=1`.
- `content-visibility.test.tsx`, `content-visibility-auto.test.tsx`: skipped loops draw nothing over 60 ticks (the `auto` ones wait
  200 ticks, since the scrollbar fades and draws after a scroll); the culled-transition test pins `transitionend` coming.
  The skipped pages sync no motion over a hover (`motionsSynced` 0), a forced read of one card syncs at most 2 (4 under the
  verifier, which runs the pass twice), and "animations in auto content that is near but clipped away by an overflow hidden scroller"
  pins that content scrolled out above the clip, below it from the start and pushed out below it costs what an empty page does.
- gpui `window/patch_tests.rs`: a page of 10 and of 1000 static retained roots beside one patchable root whose colour moves does the
  same work (patch counters, zero replays and builds), the patched scene equals the frame built whole, also in a scrolled scroller,
  with the accessibility tree on, and with the pointer on a hitbox in the root; each decline reason; a tick that changes no
  operation presents nothing; a wrong patch is a mismatch under the verifier; lifted roots alone, between lifted boxes, positioned in
  their parent, and in a root that a frame replays; a lifted unit patched at 0.5, 1, 0, 0.25, 0, 1, 0.5 keeps the operations of
  every frame; a unit that holds the focused element; eight holders registered and repainted in place, with the verifier, a
  scroller, replay and hover over them, an absolute root under each holder with the block moving between ticks, and one that
  escapes the clip around it;
  `a_tick_that_changes_one_root_costs_the_same_whatever_the_page_holds` (`bounds_inserts` 10 for 5 ticks of the unit on 10 and on
  1000 rows).
- gpui `scene::tests`: a scene made again with other colours is the scene painted so (groups, a layer and glyphs included, with no
  order worked out); after something moved it is the scene painted so; a rebuild twice, and an insert after one.
  `cargo test -p gpui --lib --features test-support scene:: patch`: 92 passed.
- `events/hover_paint.rs` unit tests: a colour, a shadow colour, an opacity that stays a layer, every border colour spelling and
  a background are paint; a border width or style, a layout property, a font, a transform, a cursor, a gradient, a custom
  property, a shadow that moves or appears, an opacity that crosses 1 and a transition are not; a colour that appears or goes is not
  (a background, a text, a border, a shadow, an outline); a colour a transition below inherits; what might lift. `events/dispatcher.rs`:
  what a hover change names (a colour, an entered parent, `whileHover`, a group, `hasHover`), that `hover_would_matter` is false for a hover that only paints and true for a listener, a layout hover and a group,
  and what `dispatch` hands out as `paint` and as `restyle` (a listener, a layout hover, a press beside a paint one, an inline span).
- react `hover-patch.test.tsx`: a paint-only hover, one that changes the padding and one that a `pointerenter` listener hears,
  over a virtual list and a plain column, cross the rows and back: the picture, the boxes, what is under the pointer and the cursor
  are what patching off draws (also under the verifier, with 0 mismatches), a tick is asked for only by the first, and the listener
  hears the same events; the paint hover is a patched frame for each crossing in a column and a list, none built whole, with
  `sceneRebuilds` at most 1 and `inPlacePrimitives` above 0; a `:has(:hover)` ancestor too big to be a root is `Hover` and a frame
  built whole, in a root it is patched; a group is a frame built whole, however small.
- gpui `window/hover_patch_tests.rs`: a row recorded to be put elsewhere is patched where it was recorded and paints what the frame
  built whole paints, two rows write in place, a row put elsewhere than it was recorded is declined as `Relocated` (and a row built
  where it stands after a scroll is patched), a patched row keeps a scroll from putting back the paint before; `scene::tests`:
  operations are told apart by their fields and a `Replaced` marker is the same whatever its `derived`.
- `retain.rs` unit tests, hover: a hover is no source of a tick; the outermost root that holds a hover is the patch root and holds
  what is in it; a skipped page hides the roots in it; an element no root holds is `Unpatchable::Hover`; a root found unfit blocks the
  roots in it all the same; a frame after a patch builds the roots it repainted; a frame takes the restyled elements.
- `retain.rs` unit tests: the unit choice (outermost, paint-only, size cap, exclusion, scroll, lift, absolute, nothing skipped
  inside), the preview (each decline, dormant, no effect on the next frame), the capturing tape, a patched tick and a tick declined
  after its clocks stepped under the verifier, each refusal and its key, an absolute element and one holding a box against it are
  units, the record made on the other side of a run, a blinking element is a unit unless a layout animation also runs, a caret is
  touched by the tick of its phase and no other, a bound element is touched when due and not otherwise, motion under no box, an
  `<svg>` waiting for its raster, an `<svg>` too big to raster at rest is a unit. `bindings.rs`: `binding_due` across a run, its
  end, a write, a transform, a control and an unparsable binding; `demand`; `advance_dormant` leaving the last frame's findings.
  `svg_paint.rs`: `unsettled`, the in-paint key, the culled note.

Run with `GPUIX_RETAIN_VERIFY=1` as well. Counters and the verifier are in [testing.md](testing.md).
