# Syncing with upstream

Ghia takes commits from gpuix, from remorses' zed fork and from zed itself one at a time. There is no mirror branch and no rebase: `main` and zed `poc` only
grow (see [Repos and branches](working-on-the-fork.md#repos-and-branches)), and a ledger below records how far each upstream
has been reviewed.

- gpuix upstream is `upstream/main` (`remorses/gpuix`).
- zed upstream is `upstream/gpuix` (`remorses/zed`), in the `zed/` submodule.
- Zed itself is `zed-industries/main` (`zed-industries/zed`), a remote named `zed-industries` in `zed/`. Fetch it from
  GitHub (`git remote add zed-industries https://github.com/zed-industries/zed.git`, then `git fetch zed-industries main`).
  Do not fetch it from another local clone: that failed with "bad pack header".

## Ledger

Reviewed through, one SHA per repo. A commit at or before the SHA was taken, adapted or skipped. The start values are the
merge bases of the fork and upstream when the ledger began.

| Repo | Reviewed through |
|---|---|
| gpuix (`upstream/main`) | `515df198fef2685f5ed7dd120bf0db638eb5c360` |
| zed (`upstream/gpuix`) | `2565b8a3e33537c3d3f56d0d45f11e50a17e512d` |
| zed itself (`zed-industries/main`) | `1d7e5f1d014`, the merge base with the fork (2026-08-26) |

The zed-industries row is not advanced by the picks below. A survey of the 197 commits since that point that touch `gpui`
chose the picks and left the other rows undecided, and a SHA means everything at or before it was decided.

### Taken ahead of the ledger

Picked from `zed-industries/main`, oldest first, with `cherry-pick -x`. The zed SHA is the commit on `poc`; the picks
were made on a branch that `poc` is fast-forwarded to, so the SHAs are the same on both.

| Upstream | Subject | How | zed |
|---|---|---|---|
| `0eda7703f6` | gpui_macos: Release the accessibility adapter when a window is dropped | taken | `96ddb37da51` |
| `96e95edac4` | gpui: Skip sprites whose atlas texture was released instead of panicking | adapted: Metal only | `49adb9798f1` |
| `e71963a599` | gpui: Fix panic when hit testing past a wrapped line's width | taken | `5eac4c7d6d8` |
| `382ff7a64b` | gpui: Stop synthetic mouse drags after button release on macOS | taken | `27834e929c5` |
| `90d8514059` | gpui_macos: Fix blurred window backgrounds on macOS 27 | taken | `0f1867d64ad` |
| `e18de65b75` | gpui: Composite translucent layers with source-over alpha | adapted: the root pipelines take the fork's `destination_alpha` parameter | `d8eeb34ca1f` |
| `e4a3732b94` | gpui: Fix text system reference cycle through pooled line wrappers | adapted: by hand, the fork's `LineWrapper` has a third width cache | `8971cc9eec7` |
| `2529740084` | gpui: Wrap arena in an Rc to prevent UB | taken | `30354096279` |
| `8fa085e397` | gpui: Repaint cached views when inherited opacity changes | adapted: only the `view.rs` part | `feb7dfe73a1` |
| `decd2399b1` | gpui: Keep subscriptions for entities read by reused cached views | adapted: by hand, on the fork's `detect_accessed_entities` | `32da8eec054` |
| `c7bea34383` | gpui: Fix cursor reverting when a drag starts | adapted: the drag-area arrow keeps priority | `316529b49c3` |
| `d01f125837` | gpui: Fix key equivalents for 'backspace' and 'delete' on macOS | adapted: the fork's older cocoa imports | `1d7be50b162` |

An adapted pick says in its commit body what changed and why.

### Skips

Worth remembering, with the reason (a commit that looks wanted but breaks something):

- `db7f9ceed7` + `f6838a7c4a` (zed-industries): macOS mouse tracking moves mouse-moved events from the window to a view
  tracking area. A moved event over a `<webview>` or `<nativeview>` then bypasses `NSWindow sendEvent:`, where
  `window/composition.rs` hands it to the native container, so hover would stop working over pages. It also splits
  `Floating` out of the arm Normal, Floating and Panel share. Needs a look over a live webview before it can be taken.
- `abd9b3cbd2` + `79fe6a645f` (zed-industries): a cancelled keychain prompt becomes an error, and
  `write_credentials_if_not_exists`. Both edit `gpui_apple/src/keychain.rs`, which the fork does not have (the keychain code
  is still in `gpui_macos/src/platform.rs`), so the pick is not mechanical. Nothing in Ghia reads credentials.
- `f0d8b0b0cd` (zed-industries): a hover listener mode that keeps hover after a keypress. Opt-in with an unchanged
  default, and Ghia builds `:hover` and `mouseenter` from its own pointer state, which a keypress does not clear; it never
  calls GPUI's `on_hover`.
- The wgpu and DirectX hunks of `96e95edac4`: their atlases are restructured in the fork, the fork is macOS-only, and the
  Windows code cannot be compiled here. The wgpu atlas still panics on a missing texture.

## Engine patches we carry

The `zed/` fork changes GPUI only for what Ghia needs (DOM semantics, composing with native views, retention, things Ghia
cannot do without); the engine otherwise stays as upstream ships it, and upstream picks go in as upstream wrote them (see
[AGENTS.md](../../AGENTS.md) step 3 of "Do not invent behaviour on top of GPUI"). Any other engine change
needs the owner's explicit permission and an entry here: the decision, the considerations and the reasoning. A sync keeps
each entry or applies it again.

### A scroll anchor picks a root a translate put in from the box the page had it at (zed `taffy.rs`: `TaffyLayoutEngine::unplaced`, `note_entered_origin`, `mark_computed_unplaced`, `anchor_facts`, `layout_bounds`; zed `claude/div-membership`)

- **Decision.** A layout-engine change for what Ghia needs (a scroll that builds the children a commit put into a scroller's content must make the scroller anchor as it does after a frame built whole), in the patch mode that is opt-in per window (`Window::set_scroll_patch`); a window that does not turn it on is as before. Owner OK'd 2026-11-28 (the TanStack row-change work). Not upstream behaviour: upstream has no scroll patch.
- **What it changes.** The roots a scratch pass laid out (`Window::build_enter_group`: each child that comes in is laid out as a root of its own, then put in the frame shown) hold the boxes of that layout, which are not the page's. `draw_entering` records the origin a layout of the page gives each root that scrolls with the content (`note_entered_origin`), and `mark_computed_unplaced` keeps it with the node (`Unplaced::Fresh`, which a later translate makes `At`). While a scroller picks its anchor, `layout_bounds` reads a root that is `At` from the record, and `anchor_facts` reports the other marked nodes (a `Fresh` root, a node with no record) `hidden`, so they are skipped as a node that was never laid out is. The mark ends when the page computes the node and when a pass that lays out the page ends (`end_pass_of_page`); the end of a scratch pass keeps it. A relayout patch is declined while a mark stands (`has_unplaced`).
- **Considerations.** The pick of a frame built whole is from the layout of the frame before it, so the roots the latest translate put in are not candidates and the earlier ones are; the record is of the layout before and is read only by a pick (a read of the boxes in any other pass is of the layout of a root of its own). A stale mark would hide a real box from the anchor of a later frame, which is why it is cleared at the end of the next non-scratch pass of the page. A node a scratch pass computed as a root and the translate did not record (a root that does not scroll with the content) stays `hidden`.
- **Reasoning.** Without it the scroller picks as its anchor the box that holds the roots, where a frame built whole picks the first root in view, and the offsets differ whenever the two move differently (a box above grows, a root is put down inside the box).

### A platform can open its windows invisible (zed `gpui_macos`: `MacPlatform::invisible_windows`, `MacWindow::open`; branch `claude/offscreen-live-tests`)

- **Decision.** A test-support change for what Ghia needs (a suite that opens live windows must not show them), opt-in per platform exactly as `keep_window_frames` is; a platform that does not call it is as before. Owner OK'd 2026-11-27 ("open test windows off-screen so they don't flash"), fork-only. Not something an upstream GPUI app asks for.
- **What it changes.** A window gpui opens after it is `alphaValue` 0 and ignores the mouse before it is ordered in, and is raised to `NSFloatingWindowLevel` after its kind's level is set when that level is lower (never lowered; sheets left alone). AppKit's own panels, alerts and menus are not covered. Ghia calls it when `GHIA_TEST_INVISIBLE_WINDOWS=1` and the addon has the `test-support` feature, which is a default feature and on in the published addon, so the environment variable is the only gate; only `bindTestRendererScope` sets it. Zed `88b718fd16` (on `6b6e5700ad`).
- **Reasoning.** A display link starts only for a visible window on a screen, so a window on no screen cannot be the answer, and AppKit counts a transparent one as visible. The floating level keeps another app's window from occluding it. See [testing.md](testing.md#live-windows-in-tests-stay-invisible).

### A node's layout input is normalized before the cache and the computation (zed `third_party/taffy`: `tree/input_norm.rs`, `compute_child_layout` in `tree/taffy_tree.rs`; zed `de983ebaff`, `c72b32891b`)

- **Decision.** A layout-engine change for what Ghia needs (a subtree that mounts should not size its nodes again for inputs that cannot differ), inside the vendored taffy. Owner OK'd 2026-11-16, fork-only. The idea is from zgui (cephal 0.2.0), whose `normalize` runs before its cache. Always on, no switch. Not upstream taffy behaviour.
- **What it changes.** `compute_child_layout` normalizes the input once, and the result feeds both the cache and the computation (`SavedLayout` keeps what the parent asked, which a boundary is asked again with and normalizes again). The parent size is dropped on each axis the node's own style does not resolve a percentage, calc or `fit-content(%)` against (`NodeData::reads_parent_width` and `reads_parent_height`, set with the style); a table keeps both. A block container with children and no known height gets a max-content available height. A tree that has had a float style is not normalized at all (the float context a block passes to its children is not in the cache key, and a parent size change used to force the recompute of how a child avoids a float; `floats_seen`, the flag the relayout boundaries use). A relayout probe records whether its node was a block container when it took the questions, and a node that is not one anymore is a changed answer: the keys of a block container hold the rewritten available height, which a leaf with a measure function would be asked.
- **Considerations.** Exact by reading the algorithms: `inputs.parent_size` is used only to resolve the node's own padding, border, margin (against the width) and size, min size and max size, and is passed to no child and to no measure function (a table is the exception: `inner_width_hint` hands `parent_size.width` to `cell_parent_size`, so a table keeps both axes); `compute_block_layout` reads the available height nowhere (its children get their own). Left out: min-content and max-content interchangeable on the width axis (the answers differed, so it is not exact without knowing what the algorithm observed), the same on the height of a flex container (no CSS rule makes it exact), and a both-axes entry answering one axis. The parent-size part mostly gives back what the fork's own key widening cost (zed `27a13ddb`, the fully associative measure cache, put the whole parent size in the exact-key match; upstream keys the parent width only in a measurement entry, and its final-layout entry compared the whole parent size). The probe guard closes a path the review found by reasoning that no test could reproduce: the placement re-ask uses the original input, which is normalized afresh against the node as it is now, and already falls back for the scenario (a block that lost its last child and is measured by the available height); a sweep of 144 container variants and the fuzz kept passing before the guard, and stay as regression guards. Checked by the unit tests in `input_norm.rs` (including the float tree and a table of block cells, on and off) and a differential fuzz that lays random trees (flex, grid, block, percentages and calc in size, margin and padding, a measure function that depends on the available height, edits between layouts; seeds 0 to 2000) out with normalization on and off (a test-only switch inside taffy) and compares every node. That fuzz is the differential evidence; the gpui engine fuzz is a consistency check, since the off switch is `cfg(test)` inside taffy and not reachable from gpui.
- **Reasoning.** The Settings dialog mount of `examples/solid/mount-cost/raw-layout.ts` sizes 2188 nodes instead of 3185, lays out the same 297 and measures the same 680 leaves, and costs 8% fewer instructions per mount (frame 38.98M to 35.43M, total 43.65M to 40.12M); the detail navigation 1.5% (13.15M to 12.94M), about 3.6K instructions per avoided sizing. Raw GPUI gets the same gain, so it does not narrow the gap to GPUI.

### A node that answers what its parent asked as it did keeps the parent's results (zed `third_party/taffy`: `tree/taffy_tree.rs` `soft_stop`, `lay_out_changed_nodes`, `tree/cache.rs` `measured_questions`)

- **Decision.** A layout-engine change for what Ghia needs (a content edit in a row of a big scroller must not lay the scroller out again), inside the vendored taffy that already carries relayout boundaries; on wherever relayout boundaries are on (`TaffyTree::set_relayout_boundaries(false)` turns it off). Not upstream taffy behaviour: upstream marks every ancestor dirty. Owner's design, Slice 2 of the layout-boundaries plan.
- **What it changes.** The dirty walk ends at a node whose parent has its layout, flex, grid and block items included (the static boundary rule excluded them). Before it clears the node's cache it keeps the questions the cache holds (each size measurement, rebuilt from its key, and the last placement); `compute_layout` lays the node out again under each, before the pass from the root, and keeps the parent's caches when every answer is the same. A different answer makes the parent the node of the walk. Eligibility is content-driven dirtiness only (a descendant, a child list, a context); a style change of the node is never the stop. Not eligible: table parents and parts, baseline-aligned flex or grid items, a node whose cache evicted a measurement, any block parent once a float style was in the tree.
- **Considerations.** A parent's algorithm is a function of its style, its children's styles and the answers it gets, so equal answers to every question it asked give the same pass; the cache holds the questions of its last pass and of older ones (laying out under more is only slower). What the cache cannot hold is a placement before the last one (the baseline passes) and the float channel of a block context (outside `LayoutOutput`), hence the exclusions; an eviction means a question may be missing. The pass runs before the layout from the root so that no parent pass asks a node with a change a new question that its other cached results would not know of. A block item is laid out again with a block context of its own, which is the same as the parent's while no float exists. The content size is compared unless the node clips on both axes. The nodes above the one the walk stops at move `dirty_generation` (gpui's intrinsic widths are kept by it) and, unless the change is to the context of a measured leaf, `layout_generation` too (extents, scroll reaches and retained layouts; the gpui engine fuzz found them stale when a style or a child list change did not). A size measurement that placed a node under it (a flex or grid container's baseline pass) forgets that node's final layout, since the layout below it is no longer the result of its last placement, and a node whose parent was cleared since the mark is not laid out under the old questions. Checked by `relayout_boundary_tests` (the differential fuzz covers flex, grid and block parents, baselines, margins and a stretch in a shrink-to-fit container; seeds 0 to 20000), the gpui engine fuzz (seeds 1 to 20000) and the window patch tests.
- **Reasoning.** A text edit in a fixed-height row of a 10k-row scroller was a contained patch that still cost 83.9M instructions, all taffy running the scroller's flex pass over its 10k children because the row is a flex item. It costs 6.3M now (`examples/solid/layout-scale/profile.tsx` op a2 at 10k rows; 2.2M at 1k, 3.0M at 3k). See [layout](layout.md#relayout-boundaries) and [patch frames](patch-frames.md) for the measure.

### A patch rewrites the recording of a root recorded to be put elsewhere, also one a scroll or a frame built whole moved (zed `window/patch.rs`: `prepare_unit`, `finish_unit`, `Window::relocated_rewrite`; `elements/retained.rs`: `prepaint_skipped`)

- **Decision.** A retention change for what Ghia needs (box roots in the rows of a scroller), in the contained-patch mode that is already opt-in per window (`Window::set_contained_patches`); a window that does not turn it on is as before. Not upstream behaviour: upstream has no relayout patch.
- **What it changes.** A patch that lays out again a root recorded in a region of its own (`retained(..).relocatable(..)`, the row of a scroller) used to prepaint and paint it in the frame and drop its recording (`PatchSource::rewritable` is false for a recording with a `Relocation`), so the next edit was `StaleRecording` and a frame built whole. It now prepaints and paints it in its region (where it was recorded), puts what it made where the frame has the root, `delta` from the region (the scene as a replay puts it, the hitboxes moved and cut by `Window::place_hitboxes_from_region`), splices the frame, and rewrites the recording with the region's operations, hitboxes, clip decisions and handles (`RecordingRewrite::relocation`) next to the new ranges (`prepaint_lengths`, `paint_lengths`). The recording keeps its key, region and `delta`, so the next replay or translate moves it from where it was recorded as before. A root that a scroll moved is patchable, and so is one a frame built whole replayed at a moved place: a replay that puts a root in a region of its own away from where it was recorded, under the content mask it was recorded under, and that holds no scroller of its own that the user scrolls or that is scrolled (`PrepaintRecord::holds_scroller_blocking_a_move`; an `overflow: hidden` box at offset zero is neither: its offset and extent are relative to the padding box and its handle is rewritten with the recording), registers it (a root laid out again or not, `elements/retained.rs` `prepaint_skipped`), as a translate leaves a row (`RetainedState::scrolled_to` sets what the replay sets), where one whose mask differs, that is culled or direct, or that holds such a scroller (a patch of it is declined after it is built) is still noted as relocated and declines `Relocated`. A patch that does not lay the root out again rewrites the recording the same way (`PatchSource::relocated_rewritable`), so the translate that follows moves the paint of the patch. Declined `Relocated` too: a hitbox placed by a box outside the root, a scroller of its own in the root that the user scrolls or that is scrolled (`ScrollerRecord::blocks_moved_patch`, read from the scrollers the patch prepainted), a region that no longer fits where the root is. A root whose reasons not to be put elsewhere changed (`blockers`), or whose region no longer holds it, loses its recording as before.
- **Considerations.** What a relocation stores (the region, the clip decisions, the handles reporting boxes) is what a build of the new content in the same region records, since the patch runs the same prepaint and paint under `begin_relocation`; the replay paths (`replay_prepaint`, `replay_paint`) read `paint.operations` and the hitboxes of the recording, both replaced, and the scene range, which the splice moves. The handles the patch noted are moved by `recorded.delta` when the recording is rewritten. A replay notes the hitbox around the root, as it notes the dispatch node (`PatchUnit::replayed_under`; `Surroundings::hitbox_parent` is a `Cell`): every frame that prepaints the enclosing element inserts its hitbox again with a new id, and a patch that hung the root's hitboxes off the id of the recording left parents that the frame does not have (the DOM hit test panics on one); `hitboxes_are` leaves the parent of the hitboxes that hang off the enclosing one to that. `recorded.delta` is set only in the replayed root's own `prepaint_skipped`, so a recording nested in a root that was put elsewhere keeps an old delta: such a root is not registered at all, and a root whose mask differs from the one it recorded under is not registered for a patch with a delta, so no patch is painted at a wrong place. A patch is followed by a scroll anchoring step that a frame built whole is not (the layout pass of the patch moves the anchor): the tests turn `overflow-anchor` off where they compare the two.
- **Reasoning.** A text edit in a fixed-height row of a scroller too big to be an anchor was patched on one edit in three (every second edit a frame built whole, 323M instructions at 10k rows), and once the scroller was scrolled and moved by a wheel tick, never (245M at 10k rows, every edit a frame built whole, `Box:Relocated`); it is 9.1M and a patch every edit now. See [patch frames](patch-frames.md#how-gpui-patches-windowpatchrs) for the measure. The gpui tests are in `window/splice_patch_tests.rs`.

### A recording in a region of its own is moved with the positioned boxes it hands to the stacking context around it (zed `window/retained.rs`: `PlainPaint::relocation`, `finish_prepaint_recording`, `replay_lifts`, `replay_plain_paint`; `window.rs`: `finish_lift`, `LiftedElement::uncut_mask`; `elements/retained.rs`: `Recorded::peek_place`; zed `dcd69716bb`, `6afb64a2b4`, `1f97140307`)

- **Decision.** A retention change for what Ghia needs: a `position: relative` or `absolute` box in a row of a scroller is DOM, and a row that holds one must not be built on every scroll frame. Not upstream behaviour: upstream has no relocatable recording. Opt-in by the same means as the relocation it extends (`retained(..).relocatable(..)`), so a recording that is not in a region is as before.
- **What it changes.** A recording in a region (`Relocation::regional`) used to refuse the box it handed to a context outside it (`Lift` in `finish_prepaint_recording`), or, outside a region, record a stub and be `NonRelocatable::Hole`, so every row with a positioned box was built whenever a scroll moved it. Each such plain box (not a hole) is now a regional cell: its paint is recorded in the region as the root's own is (`begin_relocation`, `end_relocation`, `emit_relocated` under the entry's cut mask, painted under its uncut one), and the record keeps a stub of it with its mask and whether the mask is derived from the region. A moved replay hands the stubs over `delta` away, moves their hitboxes, cuts their masks by the content mask around now, and replays the cell's operations translated; the owner's hook gets `LiftedPaint(rel)` with `delta`. What a cell recorded is put under the content mask around the region (the rectangle a replay cuts the root by), not under the mask of the box the element was handed over under, so a box that escapes an overflow clip inside the row is cut by the clip it escapes to. A recording whose stubs are all regional cells is recorded; it is moved when none is under a transform, and replayed where it was recorded, not moved, when one is (`NonRelocatable::Hole`); a recording that holds a hole is refused (`Lift`), and so is one outside a region that holds a cell. The place is judged by the cells too: their clip decisions (`RelocationMiss::Clip`), their blockers and a listener that does not take the translation (`RelocationMiss::Lifted` when a cell's paint cannot be repeated translated). Ghia predicts what gpui accepts: it asks for a move of a row that hands over plain boxes, and keeps a row that hands over a hole (a lifted retained root) in place (`Node::blocks_move`, `Below::lifted_roots`); the patch root keeps `hands_lifts_out` (`PatchDecline::Lifts`).
- **Considerations.** A retained ancestor that is not in a region, around a scroller whose rows hand out cells, is refused (`Lift`), where it was recorded before; Showcase frames that do not scroll (a hover moving inside or outside the scroller, an idle frame) build the same elements per frame as the base (86.8, 43.9 and 43.6), so it is not worked around (a stub that kept the distance its cell was put at would be the fix). The paint of the cell is a recording under the same rules as the root's, so what it reads (clip decisions, rounded clips, handles) is covered by the existing checks, and the tests compare a moved frame with a build of it (scene, hitboxes, hit chains, accessibility, texts), under an overflow clip of the row, a rounded clip inside the box, z below and above the other rows' boxes, a rounded scroller, panel and card, past the region, with the pointer captured in the box, and in the fuzz. Out of scope: holes inside a region, stubs under a transform, patch paths (`PatchDecline::Lifts`). A box that a rounded clip inside it cuts differently where the row is put is built (`Clip`), as the root's own is.
- **Reasoning.** Ghia's `hands_lifts_out` alone kept every row that holds a positioned box from being a moved root, and clearing it without gpui's half made the Showcase scroll worse, since gpui refused the larger roots. The two halves together, test renderer with a release addon, a one-way wheel at 120 frames/s over 618 moving frames, base against change: elements built per frame 218.5 to 174.1, `moved:scroll` roots 79.1 to 33.6, relocations 44.9 to 45.6, lazy builds 9.7 to 10.2, `Lift` refusals 0 to 0.16 (rows that hand over a retained root) and `Hole` blockers 0 to 0.76 (a box handed over from under a transform) per frame, frame time p50 4.51 to 4.16 ms, p90 5.4 to 5.0, p99 7.8 to 7.7. The `lifted_roots` gate in Ghia (`Node::blocks_move`) is what keeps a nested lifted root from being built late with every build of its row: without it 206 built and a p50 of 8.2 ms against 6.5 for that run's base.

### A relayout patch inside a scroller that anchors is declined when the anchoring step would act (zed `window/patch.rs`: `lay_out_again`; `taffy.rs`: `pick_anchors_of`, `hold_anchor_restyles`; `elements/scroll_anchoring.rs`: `would_act`)

- **Decision.** A retention change for what Ghia needs (a patch must show what a frame built whole shows), in the contained-patch mode that is opt-in per window; anchoring itself (`elements/scroll_anchoring.rs`) is as it was. Not upstream behaviour: upstream has no relayout patch.
- **What it changes.** A relayout patch lays the page out from the window root but prepaints only its root, so the scroller around it never ran the step that scrolls it by what moved its anchor. A scroller above the root now picks its anchor before the patch's layout and asks after it (`would_act`); a patch that would scroll it or drop its anchor is declined `NotContained`. The flags a pass sets for the restyle of a node (`anchor_restyled`) are held across the end of the patch's pass and released when the patch is kept, since a declined patch has set the styles and the frame built whole after it would find no restyle.
- **Considerations.** The decline is conservative: the step drops an anchor of a restyled box as well as scrolling, and a clamped scroll that would not move the offset is still declined. Compensating in the patch (scrolling by the delta) was not done: the clamp needs the new extent of the scroller, which only its prepaint knows. A scroller that does not anchor (`overflow-anchor: none`, a list) and a root with none above are untouched; the walk up costs what `lay_out_again` already walks.
- **Reasoning.** Found by comparing a patched page with one built whole (`splice_patch_tests.rs`): a taller first box above the anchor inside a fixed-height row left the offset at -24 where a frame built whole is at -32.

### A scroll offset write, a wheel included, leaves the scroll metrics current (zed `app.rs` `notify_scroll_only`, `window.rs` `draw_if_scroll_metrics_dirty`, `scroll_metrics_are_current`, `scroll_metrics_current_at`; `elements/div.rs` the scroll-routing branch; zed `bf1977f185`, and the wheel on top)

- **Decision.** An engine change for what Ghia needs (DOM semantics: a scroll offset is a paint property, so writing it, by `scrollTop = n` or by a wheel, runs no layout, and reading `scrollTop` or `scrollHeight` after it runs none either). Not upstream behaviour: upstream notifies a scroll write like a style change. A wheel uses it only in the scroll-routing branch of `div.rs`, which is taken only where Ghia's DOM hit testing and scroll routing are on; the branch without them keeps upstream's `cx.notify`.
- **What it changes.** `App::notify_scroll_only` records a second `update_count` next to the layout's; a scroll write finds the metrics current and keeps them, and `Window::draw_if_scroll_metrics_dirty` runs no pass while that holds. `draw_if_dirty` still lays out, since the children moved. The caller must have clamped the offset to the extent of the last layout; `scroll_routing::claim` does for every axis it moves, and an axis it does not move keeps the offset it had.
- **Considerations.** Any other invalidation before or between the writes makes the metrics stale again, and a caller must have clamped the offset to the extent of the last layout: a wrong call here is an offset beyond the extent, which the scroller clamps in its next prepaint. An embedder that writes offsets asks `Window::scroll_metrics_are_current` (a small accessor added for it) instead of keeping a record of its own, since a record kept beside gpui's does not follow a wheel. List wheels, scrollbar drags and keyboard scrolls are not changed here.
- **Reasoning.** A spring writing `scrollTop` each frame ran 57 layout-only passes in 30 frames, where Chrome runs none (#70). A wheel on a scroller whose `scroll` listener reads `scrollTop` (TanStack Virtual) ran a layout-only pass per tick, 27% of the tick in the profile. Tests: `window::tests::test_a_scroll_write_only_makes_the_boxes_stale`, `elements::div::tests::dom_hit_testing::a_wheel_on_a_scroller_leaves_the_scroll_metrics_current`. See [scroll writes](scroll.md#scroll-writes-70).

### Partial redraw (zed `window/damage.rs`, `scene.rs`, `platform.rs`, `composition/present.rs`, `gpui_apple/src/metal_renderer.rs`, `gpui_macos/src/window.rs`; zed `0cad85379a`, `0800fee7da`, always on in the merge of `claude/s4-dirty-regions`; the shift and the culling on zed `scroll-pixel-reuse-cull`, `window/scroll_patch/shift.rs`, `metal_renderer/partial_bench.rs`)

- **Decision.** Approved by the owner (2026-11-08, "GPU damage from patches" in the Stage 4 plan, to be built at the end and compared with and without). It was built opt-in and measured; Farrel 2026-11-09: always on, no opt-in. There is no `Window::set_partial_redraw`, no `GPUIX_PARTIAL_REDRAW`, no renderer option and no `TestRenderer.setPartialRedraw`: every window computes its damage and hands it to `PlatformWindow::draw_with_damage` (a defaulted method that calls `draw`, so a platform that cannot draw in part is as upstream draws it). Metal draws a frame whole when the scene has an effect group or a surface, the window is transparent, it has native surfaces (`draw_composed`), the size changed, the damage is unknown (a rebuild no site said) or the target was left stale; a sync that touches those conditions has to keep them. `GPUI_GPU_TIMES=<file>` stays as a documented measurement switch ([testing.md](testing.md#driving-a-live-window)).
- **What it changes.** The window computes the damage from what the patches write (`PaintOperation::extent`, the old and the new area of each operation, a shadow's with its blur), a scroll translate's moved runs and a thumb's repaint, and any rebuild it was not told of is all of the window (`Scene::revision`). Metal keeps the picture in a texture of its own, loads it, draws the scene under a scissor of the damage after painting the scissor black, and copies it to the drawable. See [paint-and-transforms.md](paint-and-transforms.md#partial-redraw).
- **Considerations.** Upstream tried it and none merged: https://github.com/zed-industries/zed/pull/53932 (damage bubbled up from the elements), /pull/59441 (a diff of two consecutive scenes, `SceneDamage::between`, wgpu on Linux with `present_with_damage`), /pull/59461 (the property test of that diff) and /pull/62455 (`GPUI_EXPERIMENTAL_PARTIAL_RENDER`: a persistent target, a scissored draw per rectangle of up to 8, a copy; Linux only; it reports a 4x GPU and power cut for editing and 7x for a hover that changes nothing), all closed unmerged; issues /issues/15166 and /issues/8043 are open. A diff of scenes costs a pass over the primitives of every frame, which a patch frame does not pay now (a patch knows what it wrote), so the damage here comes from the patches, and a frame that is not a patch is all of the window. A mistake is a stale pixel, so every site that writes over the rendered scene says what it wrote, a rebuild that no site said is all of the window, and the tests compare the damage with what differs between the scenes and the pictures with a whole draw. Not done: more than one rectangle for anything but a shift (otherwise the damage is the union), a group or backdrop that does not meet the damage (any group is all of the window, which is more than it needs to be; tested for opacity, blur, backdrop blur and drop shadow), a drawable that is reused without a copy (buffer age: a drawable's contents after it is presented are not defined), a transparent window.
- **Reasoning.** The mailbox of ghia-bench in a live window, 1280 x 800 at scale 1: a frame costs 0.85 ms of GPU whatever it changes, and 0.28 ms for a patch of two rows with the patch; a hover phase goes from 25 to 12.6 ms of GPU time in 4 s and idle from 16 to 4.5 ms in 10 s, the scroll phase (frames built whole) is the same. Costs, measured on and off back to back (two runs each): a frame built whole costs +8% GPU for the copy (0.85 to 0.92 ms), a hover patch frame goes from 0.84 to 0.28 ms, a thumb repaint 0.86 to 0.23 ms and a scroll translate 0.86 to 0.61 ms; the encode of a patch frame costs 0.1 ms more CPU (0.53 to 0.65). The GPU is busy 0.2 to 0.6% of the wall time in those phases, so the saving is small in absolute terms on this display; it grows with the pixels of the window. Always on at the owner's decision, with the 2x display and the energy (needs root) not measured.
- **Shift and culling (2026-11-17).** Decision: taken with the owner's OK (2026-11-17); like the rest of partial redraw it is always on with no switch, option or environment variable (the debug switches the prototype measured with, `GPUI_SCROLL_SHIFT_OFF` and `GPUI_DAMAGE_CULL_OFF`, are removed). What it changes: a scroll translate reports a `Shift` of the list's pixels plus a residual instead of the list's rectangle; the ledger holds a shift and its residual (`window/damage.rs`, `FrameDamage` replaces the rectangle in `PlatformWindow::draw_with_damage`, whose default still calls `draw`; the test platform and `gpui_macos/src/window.rs` follow); `window/scroll_patch/shift.rs` decides when a translate is one; Metal copies the kept pixels through a scratch texture and draws the scene once per rectangle with that rectangle as its scissor, each scissor drawing only the primitives that meet it (`gpui_apple/src/metal_renderer.rs`: `blit_shift`, `per_scissor`, `culled`; paths are not culled). Considerations: a sync that touches the damage or `draw_with_damage` has to keep the shift's meaning (every pixel of `region ∩ (region + by)` is the old picture's pixel at `q - by` except in the residual) and the rule that an operation that does not move with the rows and meets the region is residual unless it is a solid quad around the region; the shift is given up for the plain union for more than 4 rectangles or over 60% of the region, rows under different clips, a rounded clip and a move that is not whole device pixels. It is Metal only and a macOS-only surface; the cost is a scratch texture (from the renderer's texture pool, so it is freed after idle frames) and a blit (+0.067 ms in the bench). Reasoning: in a live mailbox scroll a translate frame is 40 to 45% of the GPU time and drew a third of the drawable for a 60 to 120 px move; the bench (2560 x 1600, 6.3k primitives) gives 0.383 ms for today's translate and 0.241 ms with shift and culling, and the live scroll phase went from 720 to 524 ms of GPU (mean of 3, -27%). The shift alone did not show live; the culling is what makes frames of 2 to 3 rectangles pay. Tests are listed in [paint-and-transforms.md](paint-and-transforms.md#partial-redraw).

### Plain quads take a light fragment shader (zed `eea878e63f`, `gpui_apple/src/shaders.metal`, `metal_renderer.rs`)

- **Decision.** Taken at the owner's decision: always on, with no switch and no per-window opt-in, because the output is pixel-identical. It is a fix for a cost the fork added: `quad_fragment` grew with the fork's patches (borders of several styles, gradients, background tiles, transforms, rounded masks) and runs for every quad, including the plain opaque fills that cover most pixels. This removes the cost those patches added for quads that use none of their features. Upstream's `quad_fragment` is about 300 lines and reads a 160-byte `Quad`, against the fork's about 410 lines and 536 bytes, and GPUI alone scrolls the Mailbox bench at 341 ms against Ghia's 368 after this change, so the cost is the fork's own and there is nothing to send upstream. Recorded as an engine patch because it is a Metal pipeline change.
- **What it changes.** One function in `shaders.metal`, `plain_quad_fragment`, and one `plain_quads` pipeline that pairs it with the unchanged `quad_vertex` and has the same blend state as `quads`. The fragment returns `background_solid` from its interpolated inputs without fetching the `Quad`: that is what `quad_fragment` returns for a quad the predicate admits (its fast path multiplies by a tile alpha of 1, since there is no tile, and a mask coverage of 1, since the mask has no rounded corner). `draw_quads` splits a batch into maximal runs of plain and other quads, `is_plain_quad` being the predicate (all border widths 0, corner radii and the content mask's radii 0 in both axes, no background tile, a solid background, the unit transformation), and draws each run in paint order from the same instance buffer, bound once per batch. A plain run between two full runs of the batch and clipped to under 16,384 px² is drawn with the full pipeline, which merges three draws into one; a plain run at the edge of a batch or a large one keeps the light pipeline. Effect-group mask layers still draw with the full pipeline; the black clear quad of a partial redraw uses the plain one. The same pixels as the full path: `the_plain_quad_pipeline_draws_the_pixels_of_the_full_one` renders one scene through both and compares the RGBA.
- **Considerations.** Overdraw is the same, so the saving is per pixel. There is no unblended variant for opaque quads: the blend state stays the full pipeline's. Two pipelines share the vertex function `quad_vertex`, which is accepted: the positions, clip distances and colour of both are the output of one function, so they cover the same pixels without `[[invariant]]` or a library compiled with `-fpreserve-invariance` (which would also change the full shader's math and needs a newer macOS API), and `quad_vertex` and the full shader are unchanged. A plain run between two full runs is folded into them when it is small, because a pipeline switch and a draw per small cell cost more than the light fragment saves. A sync that replaces `quad_fragment`, `Quad` or the quad pipeline has to keep `is_plain_quad` and `plain_quad_fragment` in step with what the full shader reads; a new field the full fragment reads has to disqualify the quad. The `size_of::<Quad>()` assert next to `is_plain_quad` only catches a size change.
- **Reasoning.** Mailbox of ghia-bench, IOKit GPU ms accumulated per phase, one sitting, two runs each (GPUI alone in brackets): scroll 548 and 535 to 368 and 369 (341), hover 22 and 24 to 20 and 20 (20), type 40 and 40 to 26 and 26 (25), navigate 40 and 40 to 27 and 29 (29); a scroll frame 1.15 to 0.77 ms of GPU; CPU instructions unchanged. The fork's `Quad` is 536 bytes against upstream's 160 and its fragment shader about 410 lines.

### Atlas tile sizing (zed `13f5c1d1b7`, `gpui_apple/src/metal_atlas.rs`)

- **Decision.** A tile wider or taller than 512 px (`DEDICATED_TEXTURE_THRESHOLD`) gets an atlas texture of exactly its
  size, clamped to 16384. Smaller tiles stay in the shared 1024 x 1024 textures. The owner chose to carry this as a
  fork patch, not to send it upstream.
- **Considerations.** Upstream GPUI sizes every new atlas texture to `max(request, 1024 x 1024)`, so a tile over 512 px
  gets a padded 1024 x 1024 texture that no second tile of its size can share. The patch is a general engine change, which
  the rule above allows only by permission. A dedicated texture goes through the existing remove path (its last tile frees
  the slot), and allocation still tries the existing textures first. The patch lives in `push_texture`, so a pick that
  touches it, or a sync that replaces `metal_atlas.rs`, has to keep the threshold; the tests
  `test_large_tile_gets_a_texture_of_its_own_size` and its neighbours in `metal_atlas.rs` fail when it is lost.
- **Reasoning.** The Apple Music clone's 15 album covers (about 600 x 600) took 60.5 MB of IOAccelerator for 21.6 MB of
  pixels; with the patch IOAccelerator went from 73.7 to 30.9 MB, 43 MB off an app of about 260 MB
  ([round 49](frames-and-wakes.md#where-an-apps-memory-goes-round-49)). The cost is a texture per large tile instead of
  sharing, which only matters for many large tiles of different sizes.

### `Scene::finish` sort order and permutation (zed `scene.rs`, `platform.rs`)

- **Decision.** The owner approved this on 2026-11-06 as an exception to the rule above: it changes `Scene::finish`, which is
  upstream's code. It is a candidate for a PR to `zed-industries/zed` (made in a separate worktree from upstream `main`, per
  [AGENTS.md](../../AGENTS.md); not from this checkout), and until it lands the fork carries it.
- **Before.** Every typed vector was sorted in place with `sort_by_key`: by `order`, and the sprite vectors (monochrome,
  subpixel, polychrome) by `(order, tile.tile_id)`. A stable sort of elements of up to 240 bytes moves them about log n times
  each, and the tile id ordered glyphs by where the atlas happened to allocate them.
- **After.** Each vector gathers one `u128` per primitive, `key << 32 | index`, and sorts them with the stable `sort`, which
  finds the dozen sorted runs a frame comes in and merges them. The key is a number that compares as the key does: the draw
  order for a primitive ordered by it alone, and for a sprite the order, the index of its atlas texture and its kind, packed
  in that order (`sprite_sort_key`, which gives the order the derived `Ord` of `AtlasTextureId` and `AtlasTextureKind` gives).
  The index in the low half says which item a number came from, so the permutation is applied to the vector once, and each
  primitive moves once. The permutation is also what [a patch](patch-frames.md#how-gpui-patches-windowpatchrs) needs to say
  where the primitive of each operation went.
- **Why the tie-break does not show.** Primitives of one order never overlap: the bounds tree gives a primitive one more than
  the greatest order of the bounds before it that intersect it. So which of two sprites of an order is drawn first is not
  seen, and the id of the tile was not a meaningful order. (Inside a layer all primitives share the layer's order and do
  overlap; there upstream's tile id reordered them arbitrarily and the new key keeps the paint order within a texture, so it
  reorders less.) The texture is what the renderers batch by (`PrimitiveBatch::MonochromeSprites { texture_id, .. }`), so the
  batches are the same: consecutive sprites of one order and one texture.
- **Measured** (bench mailbox proxy, `examples/solid/mailbox-scroll-hover/profile.tsx`, test renderer, release addon,
  instructions per tick, two runs each back to back). Each step is against the build before it; the pairs are the two runs,
  before and after.
  - `4576d660c1` (the sort by `(order, texture)` with the permutation applied once; ghia `cef50f98`): scroll with the
    scrollbar hidden 9.41M and 9.40M to 8.96M and 8.95M; scroll with the default scrollbar 10.08M and 10.08M to 9.65M and
    9.66M; hover 0.51M and 0.50M to 0.48M and 0.47M, with the 18 row crossings under it at 10.06M and 10.00M to 9.43M and
    9.19M.
  - `b994fa4773` (one `u128` per primitive in place of the tuple; ghia `b871632e`): mean scroll 8.19M and 8.15M to 7.80M and
    7.81M; the 328 patched ticks 3.63M and 3.58M to 3.27M and 3.24M; the 392 ticks built whole 12.00M and 11.98M to 11.59M
    and 11.63M; hover row crossings 9.01M and 9.23M to 8.59M and 8.61M.
  - `3c3a4187bf` (the stable sort in place of the unstable one; ghia `c6a62710`): mean scroll 7.79M and 7.75M to 7.61M and
    7.62M; the 328 patched ticks 3.26M and 3.27M to 3.15M and 3.09M; the 392 ticks built whole 11.58M and 11.51M to 11.34M
    and 11.40M; hover row crossings 8.68M and 8.57M to 8.27M and 8.45M.
  A frame of about 2000 sprites of 240 bytes in a dozen sorted runs spent 161 us (1.27M instructions) in the sprite sort
  before and 52 us with the texture key.
- **Considerations.** A sync that replaces `scene.rs` has to keep the key and the permutation, or the op-to-slot map of
  `Scene::patch_in_place` is lost; the tests `sprites_of_one_order_keep_the_order_they_were_painted_in_within_a_texture_and_group_by_texture`
  and `a_sprite_over_another_is_painted_after_it_whatever_its_texture` fail when the key is lost.

### A transparent background quad that is kept (zed `style.rs`, `scene.rs`)

- **Decision.** The owner approved this on 2026-11-06 (option "B") as a Ghia-only change to upstream's `Style::paint` and
  `Scene::border_strips` (zed `88855d100d`), not a candidate for upstream: it exists for the fork's hover patches. It adds `keep_transparent_background`
  to `Style` (default `false`, a plain field of `StyleRefinement` like `collapsed_border`) and Ghia sets it on an element whose
  `hover` or `hasHover` gives a background colour.
- **Before.** `Style::paint_background_color` painted a quad only if the background colour was not transparent
  (`Hsla::is_transparent`, an alpha of 0). A hover that gave a background to an element with none added a quad to the operations
  of its root, so the hover was a frame built whole: the mailbox row of ghia-bench took 8.57M instructions a crossing.
- **After.** With the flag set the quad is painted whatever its alpha is: `paint_background_color` paints when the background is
  `Some` and it is not transparent or the flag is set. `border_strips` does not cut a transparent quad that has no border into
  strips (there is nothing to cut around; the strips of such a quad were an invisible ring of four quads and the operation
  would not have been one primitive a patch can write over). Nothing else drops an alpha-0 quad: `Scene::insert_quad`,
  the bounds tree, the sort and `Scene::patch_in_place` take it as a quad. **The change is not for the flagged quad alone:**
  `border_strips` sees a `Quad`, which does not say whether a style asked to keep it, so every fully transparent quad with no
  border that reaches the scene is one primitive now, whoever painted it (the caret of an input that is not lit,
  `input.rs`; the background of a run of text; any `fill` of a transparent colour). Before, one of those was recorded as an
  operation and left no primitive (its four strips had no area), except under a transform or a rounded clip, where it was one
  invisible primitive. An element without the flag paints the same pixels it did: the quad is alpha 0, but it takes an order,
  a slot in the quads of the scene and an insertion in the bounds tree like any quad, so the orders and the batches of a
  frame that paints such a quad can differ from before. Carrying the flag with the quad was considered and not
  done: `Quad` is the struct the shaders read, and the operation the frame records (`PaintOperation::Quad`, 18 match sites
  and the replay) would need a variant of its own so that a recording put elsewhere decides as the paint did.
- **Why.** The hover then writes a colour over a quad that is there in both styles (`hover_paint.rs`), and the mailbox row
  crossing took 4.48M and 4.51M instructions, all 18 patched ([patch-frames.md](patch-frames.md#which-hovers-paint-only)). A base
  background of alpha 0.0001 was tried and patched too, but it paints a (nearly invisible) colour; this is a true zero.
- **Costs.** One quad more in every row that declares such a hover, in every frame: the scroll phase of the mailbox proxy went from
  7.64M and 7.63M to 7.89M and 7.88M instructions a tick. A flagged transparent quad is shaded by the GPU over the element's area. Every other transparent quad with no border costs the same, in the frames that paint one (an input's caret off its phase).
- **Considerations.** A sync that replaces `style.rs` or `scene.rs` has to keep the field in `Style`, its default, the
  condition in `paint_background_color` and the border test in `border_strips`; the tests
  `a_transparent_background_paints_no_quad_unless_it_is_kept` and
  `a_row_with_a_kept_transparent_background_is_patched_to_the_colour_of_the_hover` (`window/hover_patch_tests.rs`) fail when any is
  lost. If upstream ever paints transparent backgrounds, or gives `Style` a field of its own for it, take theirs and drop the flag.

### Recent leaves in the bounds tree (zed `bounds_tree.rs`)

- **Decision.** The owner approved this on 2026-11-07 as an exception to the rule above: it changes
  `BoundsTree::find_max_ordering`, upstream's code, and any GPUI app would gain from it. It is a candidate for a PR to
  `zed-industries/zed` (made in a separate worktree from upstream `main`, per [AGENTS.md](../../AGENTS.md)); until it lands
  the fork carries it.
- **Before.** The order of a primitive is one more than the greatest order of the bounds inserted before it that intersect it.
  `find_max_ordering` answered from the leaf of the greatest order when that intersects, and otherwise searched the R-tree
  from the root: 44 nodes popped an insert over the 211 476 inserts of the mailbox scroll proxy.
- **After.** The tree keeps the last 16 inserts and their orders in a ring (`RecentLeaves`, emptied by `clear`), and a query that
  the leaf of the greatest order does not answer checks them newest first. One that intersects the query raises the answer to its
  order; one that intersects it and encloses it (edges included, `encloses`) ends the query. Otherwise the tree is searched as
  before, with the answer the ring found as the floor its pruning starts from. GPUI paints a parent before its children and a text
  layout one layer a line, so the bounds just before a child's are mostly its parent's background: in the proxy the ring ends
  85% of the queries the leaf of the greatest order does not (89% in the hover phase), and the nodes popped fall to 3.5 an
  insert. The size is the const parameter `RECENT` of `BoundsTree` (default `RECENT_LEAVES`, 16; 32 ended 87%), and
  `RECENT = 0` is the search as upstream wrote it.
- **Why it is exact.** Let the leaf L that ends the query intersect it and enclose it. A leaf older than L that intersects the
  query intersects L (its edges are past the query's, and the query's are inside L's, with the corners worked out as
  `Bounds::intersects` works them out), so its order is below L's; every leaf newer than L is in the ring and was checked. The
  floor the search starts from is the order of a leaf that intersects, which the search would have found.
- **Where it differs.** The tree's own node boxes are an origin and a size, and a box's far edge, the origin plus the size, can
  come out an ulp short of the far edge of the leaf it was made from, so upstream's search misses an overlap of an ulp (rows
  stepped by a third of a pixel near 1000 get the order of the row before, which they overlap by an ulp). A recent leaf is
  compared as it was inserted and finds such an overlap, so there the orders are the definition's and not upstream's. Bounds on
  a grid of a power of two, which a layout in 1/64 px scaled by 1 or 2 is, are added and subtracted exactly: every one of the
  853 212 numbers the proxy inserted is a multiple of 1/64, and its orders are upstream's in all 749 frames.
- **Measured** (bench mailbox proxy, `examples/solid/mailbox-scroll-hover/profile.tsx`, `A11Y=0`, test renderer, release addon,
  instructions per tick, two runs each back to back; zed `88855d100d` before, ghia `6deba69a`):
  - scroll: mean 7.87M and 7.88M to 7.50M and 7.49M; the 328 patched ticks 3.38M and 3.36M to 2.91M and 2.95M; the 392 ticks
    built whole 11.62M and 11.65M to 11.34M and 11.30M. About 1.3K instructions a bounds insert (292 a tick).
  - scroll with `NO_ROW_HOVER=1 NO_FOLDER_HOVER=1` (rows without the kept transparent background of
    [the entry above](#a-transparent-background-quad-that-is-kept-zed-stylers-scenrs)): 7.58M and 7.67M to 7.54M and 7.56M.
    The kept background cost 0.25M a tick before (7.87M against 7.62M) and nothing after (7.50M against 7.55M): it is the
    enclosing leaf that ends the queries of the row's text.
  - hover row crossings (18, all patched, 0 to 33 inserts each): median 4.07M and 4.07M to 4.05M and 4.10M, unchanged.
- **Considerations.** A sync that replaces `bounds_tree.rs` has to keep the ring (`recent`, cleared in `clear`, pushed in
  `insert`) and the scan before the search, or drop this entry if upstream takes the PR. The tests in
  `bounds_tree/differential_tests.rs` keep upstream's implementation as `ReferenceTree` and compare the orders of the tree with
  0, 1 and 16 recent leaves with it and with the definition, on random bounds, bounds painted the way a UI paints them (rows that
  touch edges, a layer a line, empty and overflowing boxes, steps of 0.1 and 1/3 up to 10 000) and two mailbox frames
  recorded from the proxy (`bounds_tree/mailbox_frames.txt`).

### Contained relayout patch (zed `4359857078`, `afccad7649`, `f9a51894e7`, `06fc9e85e3`, `b133d12651`, `52f5a22f76`, `c4590da472`, `31494a952c`, `01bf68b572`, `32f49a4a45`; `third_party/taffy`, `taffy.rs`, `window/patch.rs`, `window/patch_splice.rs`, `elements/retained.rs`)

- **Decision.** The owner approved this on 2026-11-07 (the full option 2 of the contained-layout design) as an engine change
  that lets a commit patch the frame instead of drawing it whole. It is opt-in per window (`Window::set_contained_patches`, off
  by default; Ghia turns it on where it patches ticks) and per root (`Retained::patchable_relayout`), so a window that does
  not ask for it behaves as upstream's.
- **What it changes.** taffy can note the nodes whose layout a computation changed (`track_layout_changes`,
  `take_layout_changes`: location, size, border, padding, scrollbars or content size other than before, and whether the
  location or size moved), at the cost of one check per stored layout while off. gpui's patch of a `patchable_relayout` root
  no longer declines `LayoutMismatch` for a new element with other nodes, styles or children than the recording: it computes
  the layout from the window's root (`Frame::root_layout`, with the space the frame was laid out in; whatever has an answer
  keeps it), and accepts the patch when nothing outside the root changed and the root has the box it had, otherwise it declines
  `PatchDecline::NotContained` and the frame is built whole in the same draw. What it repaints is compared with the recording
  as before, except that hitboxes may have other bounds, corner radii and clip paths, and the listeners, input handlers and
  tooltips the scratch frame registered replace the rendered frame's (their closures know the layout they were built from). The
  scrollers around the root are measured again, and an accessibility tree that is built declines it as `LayoutMismatch`.
  `PatchCounters::relayout_patches` counts them.
- **The splice (`f9a51894e7`, `06fc9e85e3`).** A root that lays out again may register, hit and paint other things than its
  recording did: the part of every frame vector it held (operations, hitboxes, listeners, input handlers, tooltips, cursors,
  dispatch nodes with their parents and focus and view maps, tab stops, scrollers, accessed element states, debug bounds) is
  replaced with what the scratch frame got, and everything recorded after it moves by how much each vector grew or shrank
  (`window/patch_splice.rs`, `PatchDecline::Splice`). The roots nested in the spliced one and the ones around it are
  forgotten: they are neither replayed nor patched until a frame built whole records them, and a frame that replays the outer
  root does not register the ones inside it. `splice_patch_tests.rs`.
- **The recording rewrite (`b133d12651`).** After a relayout patch the recording of the root is made again from the patch
  (`RecordingRewrite`, `PatchCounters::rewritten_recordings`), so the next tick patches the root again and a frame built whole
  replays it. What cannot be made what a frame built whole records is dropped as before: a root recorded to be put elsewhere,
  one that handed elements to a stacking context outside it, one whose listeners report to their owner without an `on_replay`
  hook, one with an accessibility recording, and the roots recorded inside it. A root that published (`note_publication`: any
  element with an `on_painted`, `on_painted_layout`, prepaint listener or layout probe, which every host element of Ghia has) keeps the rewritten
  recording when it has an `on_replay` hook, as a frame built whole accepts for the recording (`c4590da472`), so consecutive
  commits in a root are all patches. The patch cannot update the key the root was recorded with.
- **Prepared patches (`52f5a22f76`).** The relayout path of a patch is split into `prepare_unit` (surroundings, request_layout, the
  contained compute and the `NotContained` check, the `ReplayKey` check, prepaint into the scratch frame) and `finish_unit` (paint,
  the comparisons, the splice and the rewrite); `repaint_in_place` is the two in a row. `Window::prepare_patch(cx, build)` runs the
  first for a forced layout read, so that the read answers from the post-commit boxes and scroll metrics without a pass from the
  window's root (the publications of prepaint run at once, with `is_layout_pass()` true), and `finish_prepared_patch` or
  `repaint_in_place` for the same roots does the second without building or laying out again. While a patch is prepared
  `draw_if_dirty` and its variants run no pass; any invalidation that moves `update_count`, a draw that does not patch the roots,
  a patch for other roots and `discard_prepared_patch` discard it, leaving the layout the engine computed. A `prepare_patch` that
  declines leaves nothing prepared. `PreparedPatch` holds the scratch frame, the layout engine's pass and the element arena
  (taken from clearing until the patch is finished or dropped, hence the `build` closure). `contained_patch_tests.rs`.
  The scratch frame holds one focus for every root of a patch, so each `PreparedStep` records whether its own prepaint set it
  (`holds_focus`, `31494a952c`) and the focus check of `finish_unit` reads that: read from the frame, a root without the focus
  declined `Registrations` after a focused root had prepared in the same patch. `patch_tests.rs`.
- **The hit test of a patch with several roots (`01bf68b572`).** Each root of a patch that lays out again replaced only its own hitboxes in the rendered frame, so a root painted while the roots beside it still had their old hitboxes, and the replacement of the last root won over the others where they overlapped. `Window::refresh_hit_test_for_roots` replaces the hitboxes of every root before any paints, and `Frame::hit_test_replacing` takes the replacements as `HitboxReplacement` slices, in the order of the patch. `splice_patch_tests.rs`: two roots that overlap at the pointer, one gaining an occluding box and one keeping its box, in both orders, hit, paint and click as a frame built whole.
- **A splice with an empty old part (`32f49a4a45`).** A root that registered nothing and painted nothing and gains boxes has an empty part in the hitboxes and the operations; the splice took that for a root with no scroll runs and removed the runs of every list around it, so the next scroll declined `NoRun`. The runs now stay, placed before or after the root by the vector the run has something in. `splice_patch_tests.rs`: a list before and after such a root.
- **Why.** Navigating the mailbox of ghia-bench (the Navigate proxy, `examples/solid/mailbox-navigate`) cost 39M instructions
  a key, 12M of it the fixed full frame that every commit that lays out draws. A patch that lays out only the scroller the commit
  changed does not copy what it does not change ([patch-frames.md](patch-frames.md#contained-layout-patches)).
- **How to carry it on a sync.** Take upstream's side of `window/patch.rs`, `elements/retained.rs` and `taffy.rs`, then apply
  the two commits again: they are additions beside upstream's code (`relayout` on `Retained` and `PatchUnit`, the `contained`
  flag on `PatchWindow`, `lay_out_again`, `hitboxes_are`'s `relaid` and `Registrations`, `Frame::root_layout`, the taffy
  change set). Check that the patch still lays out from the window's root with the layout engine that drew the frame
  (`layout_engine_id`), and that `contained_patch_tests.rs` passes: a text that rewraps is patched, a leak is `NotContained`,
  an accessibility tree declines, a scroller's extent is measured again. The splice and the rewrite are three more commits
  of the same kind (`window/patch_splice.rs` is new; the rewrite is in `patch_units` and `RetainedState`): apply them in
  order and run `splice_patch_tests.rs` and the retention verifier's tests.

### A list scroll that is a translate, alone or after a patch (zed `window/scroll_patch.rs`, `elements/list/scroll_patch.rs`, `window/patch_splice.rs`, `window/patch.rs`; `a355938ce4`, `3f17e8f0a8`, `53b1476e30`, `92bd787a70`, `32ab4df63c`, `01980dc564`, `e665e8a5d2`, `dd52c2c4ab`)

- **Decision.** Part of the same approved line of work as the contained relayout patch above (the plan's G3 slices), opt-in per
  window (`Window::set_scroll_patch`; a window that does not turn it on is drawn as upstream draws it). A scroll of a list that
  changes which rows show, and a scroll that comes in the same draw as a patch, are a frame that moves the rows of the frame
  shown instead of a frame built whole.
- **What it changes.** The rows that stay are moved (`RetainedPhase::Scrolled`), the rows that leave are taken out of every frame
  vector (`patch_splice.rs`, the insertion and removal forms), and the rows that come in are built through the builder the list
  was given, each laid out as a root of its own and spliced in at its place; `ScrollPatchCounters` counts them
  (`membership_frames`, `rows_built`, `rows_rebuilt`, `rows_removed`, `composed`) and the reasons a frame stays whole (`Membership.*`, `Region`,
  `Hover`, ...). `Window::note_list_scrolled(view)` lets the owner say a list was scrolled by something other than a wheel (a
  write of its offset): it asks for the draw itself (`request_tick` on the invalidator, no view queued, no invalidation counted),
  so the write does not discard a prepared patch. In the draw of a tick, the patch is made first and the translate is classified
  and applied from the frame the patch left (`composed`), with the tick the patch took no longer held as `Clock`; a translate
  that declines leaves the patch and builds the frame whole, queueing the noted view for it. A patch of a root recorded to be
  put elsewhere (a row a translate moved) prepaints and paints it in its region, `delta` from the recording, and rewrites the
  recording (`RecordingRewrite::relocation`), so rows a translate moved are patchable where they stand and stay a translate source.
  When a scroll is noted, before the classifier reads the list, the rows of its overdraw that have no size are measured as
  `layout_items` does (`ListState::measure_overdraw`, `Window::measure_scrolled_overdraw`), so `UnmeasuredOverdraw` is held only
  for a row that shows; a kept row whose recording misses its region or a clip is taken out and built where it is as a row that
  comes in is (`Prediction::rebuilds`, counted by `rows_rebuilt`). Ghia depends on this: `build_virtual_child` runs for the rows
  measured and for the rows built again, and `TapeStore::row_built` and `Retain::forget_left_rows` answer for the second
  ([patch-frames.md](patch-frames.md#overdraw-measured-and-rows-built-again-slice-g3d)).
  A wheel on a list goes on from the live `ListState` (the listener reads the offset and the extent when the event arrives, so a write
  to the offset that was drawn as a translate is not lost to the wheel after it); the scene a patch wrote in place is described for the
  retention verifier after the splice of the same patch; and a patch of a root painted in its region does less work at delta zero (the
  hitboxes the prepaint relocated in place are not relocated again, and the recording rewrite is not given the hitboxes it then replaces).
  The hover under a still pointer is not asked of the owner: a scroll does not recompute it (it follows when the scroll ends, `events/hover_after_scroll.rs`), and the rows a translate moved are
  patchable where they stand ([patch-frames.md](patch-frames.md#under-a-wheel-slice-g3e)).
- **Why.** One key of the mailbox of ghia-bench is a restyle of two rows, a swap of the detail and a scroll of the list; each
  of the three was a patch or a translate alone and the key, drawn whole, cost 40M instructions
  ([patch-frames.md](patch-frames.md#a-key-in-one-draw-slice-g3c)).
- **How to carry it on a sync.** The additions are beside upstream's code in `window.rs` (`draw`: the patch before the
  classification, the decline that queues the view), `window/patch.rs` (the relocated source, the rewrite) and the list element
  (`elements/list.rs`: the entry points `elements/list/scroll_patch.rs` uses). Run the filters `scroll`, `patch`, `retained`,
  `membership`, `hover`, `splice_patch` and `contained` of `cargo test -p gpui --lib --features test-support`, which pin each
  piece, and the retention verifier's steps in `membership_patch_tests.rs`.
- **With a screen reader connected (zed `ebb97a0`, `window/a11y/scroll.rs`).** Decision: the owner's report that every list wheel tick
  was held as `A11y` for a VoiceOver user (719 of 720 ticks in the mailbox proxy), so the translate edits the accessibility tree the
  frame shown sent instead of holding. What it changes: `A11yRecording` and the retained `TreeUpdate` of the debug dump are what a
  translate reads, the scratch frame of the rows that come in has a tree builder and maps of its own (`begin_rows_scratch`), a
  translate sends the platform a partial update (`PlatformWindow::a11y_tree_update`, no `tree`), and `ScrollApplyDecline::A11y` is
  the decline. It is carried beside upstream's `a11y.rs`: the `tree_sent` field set in `draw_roots`, `relation_targets` in the node builder
  (set where `resolve_relations` takes the pending relations), `moved_bounds` split out of `moved_node`, the `mod scroll`, the
  accessors of `A11yDebug`, and the test platform's `record_a11y_updates`. Run the `a11y` filters and `membership_patch_tests`.

### The marks of a text kept across widths (zed `2b2da134c4`, `gpui/src/text_system/line_layout.rs`, `line_layout/snap.rs`, `shape_store.rs`)

- **Decision.** Taken with the slice Z4a of the contained-layout line of work (2026-11-08), after a profile of a key of the Navigate proxy put 19% of the read in `snap_marks` and the end reshapes: `SnapMarks`, which is Ghia's own code (`snap.rs` is not upstream's), and the list of line ends that Blink reshapes were computed again for every wrapped layout of a text. They are kept in the window's `ShapeStore`.
- **Before.** A text laid out at the min-content, the max-content, the place and the definite widths took its kerns, soft hyphens, advances and end reshapes four to five times a read, though only the fit test reads the width.
- **After.** The marks and the end reshapes of the first width that breaks a line are an entry of the store under the key of the text with no wrap width, no insets and no tab size (the strut font and `nowrap` stay, which shape the line); the other widths take them. They age and go with the fonts as the layouts do. `TextCounters` counts `snap_computations`, `snap_cache_hits` and `end_reshape_computations`, which Ghia reads as `getLayoutCounters().snapComputations`, `snapCacheHits` and `endReshapeComputations`.
- **Why it is exact.** The marks read the shaped line, the text and the item starts, none of them the width, which only gates the fit test; `text_system/snap_cache_tests.rs` compares whole layouts of 11 texts at 8 widths with the store warm and cold.
- **Measured** (release, 11 paragraphs at 5 widths, back to back): 0.50 ms a round without the cache, 0.42 ms with it. A per-glyph advance cache in `gpui_macos` (`e1a4e822e3`) gained nothing on those warm rounds and was dropped. New text is another matter: every new line asked the platform again for the advances of glyphs earlier lines had used, so `line_layout/glyph_advances.rs` keeps them for the app (zed `641c46f6da`), which takes about 10% of the instructions off the frame that mounts a Settings dialog of new strings and leaves a warm mount as it was.
- **How to carry it on a sync.** Keep the entry type in `shape_store.rs` and the two lookups in `layout_wrapped_line`; run the `snap_cache` filter of `cargo test -p gpui --lib --features test-support`.

### Row sizes declared by the owner of a list (zed `4815eaca3f`, `elements/list.rs`, `elements/list/scroll_patch.rs`, `window/scroll_patch.rs`)

- **Decision.** Taken with the slice Z4d of the contained-layout line of work (2026-11-08), after a per-row profile of a list scroll put 37% of a key that does nothing else (~3.3M instructions) in `measure_overdraw`: the row that enters the overdraw was built and laid out in a scratch frame that is thrown away, and built again when it showed. Ghia knows what a row is when its root style fixes its box, so the list is told.
- **Before.** gpui measured every row it did not show by rendering it and laying it out (`layout_as_root_unsnapped`), in the overdraw, in the walk to a scroll position and in `measure_all`.
- **After.** `ListState::set_exact_item_size(Fn(index, Option<Pixels>) -> Option<Size<Pixels>>)` (and `clear_exact_item_size`): a row with no measured size that the callback answers for counts as measured at that size, without being rendered, wherever the list measures a row it does not show. The overdraw of a scroll is measured from the declarations alone, with no scratch frame, when they cover it (`measure_declared_overdraw`); `Window::measure_scrolled_overdraw` tries that first. A row that shows is built and laid out to be painted as before; if its size is not the declared one it is counted (`ListState::measure_counters().exact_size_mismatches`) and debug-asserted, and the laid out size is used. A size already measured is kept: the owner calls `remeasure_items` for the rows whose declaration changes. With nothing set, the list is upstream's.
- **Why it is exact.** The owner answers only when its style leaves no doubt (`list_sizes.rs`), and every shown row is checked, in release too (the counter); `window/membership_patch_tests.rs` (`exact_sizes`) compares wheels, writes, the extent and `measure_all` of a list with declared sizes with the same list measured by layout, and `react/src/__tests__/list-exact-sizes.test.tsx` does it for 30 row styles.
- **Also taken, same bump** (zed `0f2308a120`, `a8f385f381`, slice Z4c): `Scene::finish` moves each item of a sorted vector once, and a patch that a list scroll follows in the same draw leaves the scene to the translate (`PatchCounters::deferred_scene_rebuilds`, `getPatchCounters().deferredSceneRebuilds`), which made the frame again twice.
- **How to carry it on a sync.** The additions are beside upstream's code: the field `exact_size` and the counters in `StateInner`, `measure_unshown` and `note_laid_out` where `layout_all_items`, `layout_items` and the overdraw measured a row, and the two functions of `scroll_patch.rs`. Run the `exact_sizes` filter of `cargo test -p gpui --lib --features test-support` and `list-exact-sizes.test.tsx`.

### A Div keeps an element state only when something reads it (zed `2c3cda3566`, `elements/div.rs`)

- **Decision.** The owner approved this on 2026-11-09, always on and with no opt-in per element or per window, as an exception to
  the rule above: it changes `Interactivity` in upstream's `div.rs`, and any GPUI app would gain from it. It is a candidate for a
  PR to `zed-industries/zed` (made in a separate worktree from upstream `main`, per [AGENTS.md](../../AGENTS.md)); until it lands
  the fork carries it.
- **Before.** A Div with an id kept an `InteractiveElementState` and took it out of the window's element-state map and put it back
  in each of its three phases (request layout, prepaint, paint: a hash remove, an insert and a compare of the id path), whether
  or not anything read it. The state is `Default` and unused on a plain host div; the elements of a Ghia tree all have an id.
- **After.** `Interactivity::state_id` hands the three `with_optional_element_state` calls the id only when a field of the state
  has a reader on the element, and `None` otherwise, which is what a Div with no id always did, so every reader already handles
  it. The readers, by field (each clause of `state_id` is one of these): `focus_handle` (`focusable`, which `track_focus` and
  `tab_index` set), `scroll_offset` and `ongoing_scroll` (`overflow: scroll` on either axis in the base style; a tracked
  scroll handle owns its own and reads no state), `pending_mouse_down`, `pending_keyboard_down` and `clicked_state` (a click,
  aux-click or drag listener), `clicked_state` (an active or group active style), `hover_state` (a hover or group hover style),
  `hover_listener_state` (a hover listener), `active_tooltip` (a tooltip). Nothing else in gpui or `packages/native` names the
  type. A new reader of the state needs a clause, and `every_feature_that_reads_the_interactive_state_keeps_it` lists them.
- **Considerations.**
  - What is read is the same in the three phases: `paint_mouse_listeners` drains the listeners, and the paint phase reads
    `state_id` before it does.
  - The state of an element that has the feature in one frame and not in the next is dropped by the frame that does not access it
    (as for any element state), so a click in progress, a scroll offset of an `overflow: scroll` that is switched off and on, or
    a focus handle made by `focusable` does not survive a frame without the feature. Before, the state lived as long as the
    element's id did. A tooltip that loses its builder is dropped with the state where it was dropped by `take()`.
  - Two differences a plain Div shows: `Interactivity::active` (nothing in gpui or Ghia reads it) stays `None`, and a mouse down
    or up over it no longer calls `Window::refresh`, which the `clicked_state` handlers bound for every element with a state did
    unconditionally (their purpose is the active style, which has its own clause). A Div whose pointer handlers matter
    schedules its own frame, as a Ghia host does through its dispatch.
  - A tuning that any GPUI app gets is not a reason for an engine change by the rule above; this one is carried because the
    owner chose to, for the per-element cost of a host tree.
- **Reasoning.** The element state was 32k instructions of a 917k row (the S4.13 split of a retain-off column
  of 50 rows by sampling) and none of it was used by a row's plain divs. Release addon, instructions per row of 50 rows, before
  (zed `f880c8e462`) and after: column retain off 916.7k to 895.7k, retain on 1130.0k to 1108.5k, list retain off 973.0k to
  949.8k, list retain on 1265.6k to 1243.5k (-2.3% to -1.7%); the list's patched crossing 3.110M to 2.993M (-3.8%); the column's
  crossing 46.44M to 45.29M.
- **Tests.** `a_plain_div_with_an_id_keeps_no_interactive_state`, `an_element_without_an_id_keeps_no_interactive_state`,
  `every_feature_that_reads_the_interactive_state_keeps_it` (click, aux click, drag, hover, group hover, active, group active,
  hover listener, tooltip, overflow scroll on each axis, tracked handle with overflow scroll, focusable, tab index) and
  `a_click_listener_added_after_a_plain_frame_gets_its_state` in `div.rs`. The splice tests of `several_roots`
  (`splice_patch_tests.rs`) count the element states a frame accesses and gave their plain divs a hover style so that they have
  some. A sync that replaces `div.rs` has to keep `state_id` and its three call sites.

### The pump ends after a key event when the embedder asks (zed `gpui_macos/src/platform.rs`: `MacPlatform::set_yield_after_key_event`, `drain_events`, `pump_app_nonblocking`; zed commits `8e5e88eee6` and `5559e3ecf2`, on the local branch `claude/pump-yields-per-key`, to be pushed to `fdarian/zed` `poc` before the Ghia branch that pins them is pushed)

- **Decision.** An embedding change for what Ghia cannot do without. Owner OK'd 2026-11-18, fork-only. Opt-in with an unchanged default: a setting of the `MacPlatform` instance (`set_yield_after_key_event`) that is off unless the embedder sets it, and `pump_app_nonblocking` takes it as an argument, so GPUI's own `[NSApplication run]` loop, the `Platform::run` path and any other embedder see the pump as upstream wrote it.
- **What it changes.** With it on, a key event (`NSEventTypeKeyDown`, `KeyUp`, `FlagsChanged`) gets a checkpoint on both sides. `drain_events` leaves a key queued, peeked in the private drain mode that runs nothing, once the call has sent an event or run a step, and returns after the `sendEvent:` of a key; `pump_app_nonblocking(yield_after_key)` then posts the block it already posts to have the embedder pump again and returns without running the run loop's sources, as `PumpOutcome { stepped, yielded_to_key }` (a pump that ran a step still says so, and none runs a second one). `MacPlatform::key_event_pending()` reports `yielded_to_key` of the last `pump_events`. Mouse and other events are drained together as before, up to the first key. Ghia turns it on in `GpuixRenderer::init` and in the test renderer's constructor. See [frames-and-wakes.md](frames-and-wakes.md#one-key-event-per-pump).
- **Considerations.** The pump used to send up to 256 events in one call, and the handlers of a key run JS inside it, where the engine runs no microtask until the call returns, so every key but the first of a batch was handled before the app's microtasks for the one before. A JS-side fix does not exist (the queue cannot be drained from inside a call on every runtime, and doing it under an arbitrary caller re-enters that caller). The cost is an extra tick per key event, so a keyDown and a keyUp are two ticks, and a pump that stops short of the sources (they run in the next one). The key's own events are not split further: a key is one `sendEvent:` and AppKit's `keyDown:` and `insertText:` of it run in it.
- **Reasoning.** Lexical, and any library that commits in a microtask or a `MutationObserver` delivery, loses keys 2 and 3 of a batch (a slow frame, key repeat) otherwise; a browser runs a checkpoint after every task, so this is the DOM behaviour (AGENTS.md: "behave like the DOM"). Opt-in keeps the change a small, upstreamable one that alters no other embedder.

### WOFF and WOFF2 fonts load through Core Text, and the platform names a font file without adding it (zed `gpui_macos/src/text_system.rs`: `owned_font_handle`, `PlatformTextSystem::font_file_info`; `gpui/src/platform.rs`: `FontFileInfo`; zed `b1a0d890ab`)

- **Decision.** An engine change for DOM and web-font compatibility: `@font-face` with a `.woff2` source is what every web app ships, and a "web library before a Ghia primitive" app cannot convert its fonts. Owner OK'd 2026-11-27, fork-only. Always on, no switch: it only adds formats that failed before (a `wOFF` or `wOF2` file was handed to font-kit, which reads it as a Mac resource fork and returns an error), so no font that loaded changes.
- **What it changes.** `owned_font_handle` sends the `wOFF` and `wOF2` signatures down the path a TrueType or OpenType file already takes: `CTFontManagerCreateFontDescriptorFromData` (Core Text unpacks both), then a native font-kit handle that holds the data once. `PlatformTextSystem::font_file_info(&[u8]) -> Result<FontFileInfo>` (default: an error, for platforms that cannot say; `TextSystem::font_file_info` forwards it) loads the file the same way and answers the family, full and PostScript names and whether the font has a glyph for "m", without adding the font. The three names are read with `get_string_by_name_key`, which returns `None` where core-text's `family_name()`, `display_name()` and `postscript_name()` panic, so a font without them is an error and not an abort. `gpui_macos` also exports `MacTextSystem`, so a host builds a text system of its own in tests.
- **Considerations.** The family Ghia aliases a face to is what GPUI files the font under, and GPUI gets it from the same Core Text answer (`family_name()` of the loaded font, in font-kit's `MemSource`), so asking Core Text is exact where decoding the `name` table (WOFF1 through zlib, WOFF2 through Brotli plus the table directory) would only be a copy of its rule, and would add a Brotli decoder crate. Ghia adds no dependency for this. A WOFF or WOFF2 file Core Text cannot read, or one whose names it cannot give, is an error from `font_file_info`; `add_fonts` itself takes a font without a full name and the first lookup of its family panics, so a caller asks `font_file_info` first (Ghia's `check_font` does, as it checks TrueType names for the same reason). Checked by `gpui_macos` lib tests on fixtures made from `gpuix-test-square.ttf` with fontTools (`packages/react/src/__tests__/fixtures/make-square-font.py`): a WOFF, a WOFF2 and the TTF give one answer and lay out alike through `MacTextSystem`, and truncated, signature-only and nameless files are refused. Only macOS: other platforms keep the default and are not worked on.
- **Reasoning.** Converting fonts by hand to TrueType is the one thing in the `@font-face` list that sent an author away from the web's own files (deviations.md listed it). Searched upstream on 2026-11-27 (`gh search issues --repo zed-industries/zed 'woff2'`): only #10833 (file icons) and #535 (a font bump) mention it, nothing on loading WOFF, so there is no PR to wait for or reuse. It could go upstream as is (a macOS font format, no Ghia concept).

### The caret is a paint operation that the window blinks, on a layer of the compositor when it can (zed `scene.rs`: `Caret`, `PaintOperation::Caret`; `window.rs`: `paint_caret`; `window/caret.rs`; `platform.rs`: `draw_with_damage`, `set_caret_layer`; `gpui_apple/src/metal_renderer.rs` hidden quads; `gpui_macos/src/window/caret_layer.rs`; zed `99a7c52`, `b7b59ed`, `71514e2`, `1d9cce4` and later on `claude/ca-caret`)

- **Decision.** An engine change for what Ghia needs (a focused input must not keep the GPU driver's render context resident), approved by the owner 2026-11-27. Not upstream behaviour: upstream paints a caret as a quad and blinks it with a timer in the editor. Always on, with no switch: a window that cannot use it (composed, another platform) falls back as below.
- **What it changes.** `Window::paint_caret(bounds, color, blink_anchor)` records `PaintOperation::Caret`, which every recording, replay, translate, splice and patch carries like a quad, and which the renderer draws as one. At present (`Window::present_carets`) the topmost caret goes on a layer when the window is not composed, the operation allows it (no general transform, element opacity 1, no effect group, flat opacity or text clip) and nothing drawn after it overlaps its clipped bounds, with no rounded corner of its mask cutting it. What is drawn after it reaches as far as its extent: a primitive its bounds (a quad with a transparent solid background, no transform and a border is its border band instead: the box less its widths (a caret that rests against the inner edge is clear of it), less the square of the inner radius at each rounded corner, a pixel further in for antialiasing, which is more than the arc covers; the border of a bordered input is a quad after its content over its whole box), an effect group its content mask grown by its filters (`group_reach`, where a mask widened by a box that escapes its clip counts too), an operation with no known extent (a native surface, a surface of frames) anywhere, so a group painted elsewhere in the window does not keep the caret off the layer. Metal then draws the scene with that quad transparent (`hidden_quads`, a copy in the instance buffer; the scene is not changed) and gpui_macos shows one `CALayer` per window above the `CAMetalLayer` at the caret's bounds, with a discrete opacity animation (1 for 500 ms, 0 for 500 ms, repeat forever) aligned to the anchor, which Core Animation runs in the render server. Every other caret the window can address is a quad that gpui draws lit or transparent from `caret_visible(now - anchor)`, with a present of its own at each change of phase (`arm_caret_blink`) whose damage is the caret's bounds and that runs no view, layout or JS. A caret gpui cannot address (a composed window, a platform that cannot draw hidden quads, an effect group or text clip around it) is painted lit or transparent by `paint_caret` itself for the phase it is in, and `paint_caret` returns `true`: its painter has to paint it again at each change of phase, which `Window::caret_needs_ticks` reports for the frame last presented (a patch paints a unit outside the group around it, so a painter hears it from there as well as from the return). The window counts the groups and text clips open around what it paints (`Window::with_effect_group`, `with_text_clip`), since a recording's own scene does not know of the group it will be put under. `Window::force_painted_carets` (test-support) makes every caret one of these, for tests of the fallback. `caret_on_layer()` and `blinks_carets()` report the rest. The anchor is the only blink state the app gives; a caret has no timer in Ghia unless `paint_caret` returned `true`.
- **Considerations.** On the M5 (macOS 27) about 70 MB of an idle window's footprint is the driver's per-process render context ("Owned physical footprint (unmapped) (graphics)"), kept resident only while the process submits GPU work at least every 1 to 2 s; a caret blinking at 2 Hz submits a frame each half second, so it never drops. Electron blinks through Core Animation with no Metal submission, and its GPU process drains to about 25 MB (evidence in `~/.claude/notes/plans/ghia-gfx-mem-2026-11-27/`). The cost: a caret over which anything later draws, a composed window, and a caret in a group stay on the old path, and a caret on the layer is above everything the window draws (a layer, not an operation of the scene), so the editing caret is painted after the glyphs everywhere ([editing.md](editing.md#painting-the-caret), a change from painting under them). The layer is a rectangle, so a rounded mask that cuts the caret keeps it off the layer. A recording replayed under a group that it was not recorded in takes the fallback at the replay, from the phase at the time it was recorded; a window that becomes composed does the same to the carets it showed. Nobody painted those, so at that present `caret_needs_ticks` turns `true` for a caret the window blinked before and `present_carets` (and the present of a composed window, `release_caret_layer`) asks for a frame with `request_tick`, which the page answers by painting the caret again (see `caret::hand_over` in `packages/native`). A caret that is `Painted` with no caret blinked by the window before it asks for nothing: normally its painter was told (`paint_caret` returned `true`), but a caret whose quad `present_carets` cannot find in the scene is not, and stays lit until the page paints it again. Nothing observes the layer's phase except the clock: `getPaintedNodeSelection().caret.lit` is computed from `caret_visible` of the clock and the anchor, not from a paint.
- **Reasoning.** Measured on this Mac (release, a scratch GPUI app with a focused caret): on the layer the AGX `lastSubmittedTime` and `accumulatedGPUTime` stayed frozen for 16 s and the graphics-owned footprint was 2.4 MB (physical 23 MB); with a quad drawn after the caret (off the layer) the GPU was submitted to at 2 Hz and the graphics-owned footprint was 72 MB. The Ghia side keeps the old tick loop as the fallback only (`TextEditorState::keep_blinking`, `EditingCaret::keep_blinking`), gated on what `paint_caret` returns, and the `Dynamic::Blink` machinery of retention serves that fallback alone.

## Procedure

1. Fetch the upstreams: `git fetch upstream` in the repo root and in `zed/`, and `git fetch zed-industries main` in `zed/`.
2. List what is new, oldest first: `git log --reverse <ledger>..upstream/main`, and the same in `zed/` against
   `upstream/gpuix` and `zed-industries/main`.
3. Decide per commit: **take** it, **adapt** it, or **skip** it.
   - Take with `git cherry-pick -x`, so `git log --grep 'cherry picked from'` finds what came from upstream. Picks from
     `zed-industries/main` go in oldest first too, and a pair that belongs together goes in or stays out together.
   - Adapt when the pick conflicts or does not fit; the invariants to keep are the conflict notes in
     [working-on-the-fork.md](working-on-the-fork.md#resolving-conflicts).
   - Skip release and version commits, Windows-only and Linux-only work, paths the fork removed, and anything against the
     DOM-semantics principle in [index.md](index.md#the-principle-dom-and-css-semantics). Fixes and additions the fork
     deems fit are taken.
4. Run the suites ([testing.md](testing.md)).
5. Advance the ledger in its own commit. A skip worth remembering is a line under "Skips" with its reason.

A picked commit has upstream's npm scope rewritten to `@ghia`, because the packages are published under it. The script
is in the body of the commit "The npm scope is @ghia".

A zed pick goes to zed `poc` first and is pushed; then a gpuix commit bumps the `zed` gitlink.
