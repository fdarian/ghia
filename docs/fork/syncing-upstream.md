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
- **After.** Each vector is sorted as pairs of `(key, index)`, a few bytes each, with an unstable sort (the index makes the
  result the stable one), and the permutation is applied to the vector once, so each primitive moves once. The sprite key is
  `(order, tile.texture_id)`: `AtlasTextureId` and `AtlasTextureKind` derive `Ord` for it. The permutation is also what
  [a patch](patch-frames.md#how-gpui-patches-windowpatchrs) needs to say where the primitive of each operation went.
- **Why the tie-break does not show.** Primitives of one order never overlap: the bounds tree gives a primitive one more than
  the greatest order of the bounds before it that intersect it. So which of two sprites of an order is drawn first is not
  seen, and the id of the tile was not a meaningful order. (Inside a layer all primitives share the layer's order and do
  overlap; there upstream's tile id reordered them arbitrarily and the new key keeps the paint order within a texture, so it
  reorders less.) The texture is what the renderers batch by (`PrimitiveBatch::MonochromeSprites { texture_id, .. }`), so the
  batches are the same: consecutive sprites of one order and one texture.
- **Measured** (bench mailbox proxy, test renderer, release addon, instructions per tick, two runs each; scroll, scroll with
  the default scrollbar, hover): see the commit message of the zed change for the numbers. A frame of about 2000 sprites of
  240 bytes in a dozen sorted runs spent 161 us (1.27M instructions) in the sprite sort before and 52 us with the texture key.
- **Considerations.** A sync that replaces `scene.rs` has to keep the key and the permutation, or the op-to-slot map of
  `Scene::patch_in_place` is lost; the tests `sprites_of_one_order_keep_the_order_they_were_painted_in_within_a_texture_and_group_by_texture`
  and `a_sprite_over_another_is_painted_after_it_whatever_its_texture` fail when the key is lost.

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
