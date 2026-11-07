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

### Contained relayout patch (zed `4359857078`, `afccad7649`; `third_party/taffy`, `taffy.rs`, `window/patch.rs`, `elements/retained.rs`)

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
  scrollers around the root are measured again, the recording of the root is dropped (no frame replays or patches from it until
  a frame built whole records it), and an accessibility tree that is built declines it as `LayoutMismatch`.
  `PatchCounters::relayout_patches` counts them. The slices that follow (Z2) splice ranges of other lengths into the frame.
- **Why.** Navigating the mailbox of ghia-bench (the Navigate proxy, `examples/solid/mailbox-navigate`) cost 39M instructions
  a key, 12M of it the fixed full frame that every commit that lays out draws. A patch that lays out only the scroller the commit
  changed does not copy what it does not change ([patch-frames.md](patch-frames.md#contained-layout-patches)).
- **How to carry it on a sync.** Take upstream's side of `window/patch.rs`, `elements/retained.rs` and `taffy.rs`, then apply
  the two commits again: they are additions beside upstream's code (`relayout` on `Retained` and `PatchUnit`, the `contained`
  flag on `PatchWindow`, `lay_out_again`, `hitboxes_are`'s `relaid` and `Registrations`, `Frame::root_layout`, the taffy
  change set). Check that the patch still lays out from the window's root with the layout engine that drew the frame
  (`layout_engine_id`), and that `contained_patch_tests.rs` passes: a text that rewraps is patched, a leak is `NotContained`,
  an accessibility tree declines, a scroller's extent is measured again.

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
