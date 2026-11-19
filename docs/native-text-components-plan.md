---
title: Native text components plan
description: Port Comet's selectable text, syntax highlighting, markdown and diff renderers into GPUIX as core features and custom elements
---

# Native text components plan

> [!NOTE]
> **Shipped.** Stages 0 through 5 are implemented. Stage 6 (a generic `<list>`)
> was dropped for a reason worth recording: gpui's `list()` takes a `'static`
> render closure that runs during layout, so it cannot borrow the renderer's
> build context. A generic list over React children is impossible in this
> architecture. Virtualization lives inside `<diff>` instead, which owns its
> parsed data and can capture an `Rc` of it. See `AGENTS.md`.
>
> Two other deviations from the plan below:
>
> - Selection state is a value on `GpuixView`, not a process global. GPUIX is a
>   library and a process may host more than one renderer.
> - `TypeScript` highlighting concatenates the JavaScript query before the
>   TypeScript one. Comet ships the TS query alone, which colours type
>   annotations and leaves every keyword and string plain.

Source of the port: [zeronsh/comet](https://github.com/zeronsh/comet) (MIT), a GPUI desktop app
for coding agents. Its `crates/ui` contains a complete, production-quality implementation of
things GPUIX is missing: **cross-element text selection**, **Tree-sitter syntax highlighting**,
a **streaming markdown renderer**, and a **virtualized unified diff viewer**.

A local copy is at `tmp/comet/` (gitignored). Fetch it again with
`bunx opensrc path zeronsh/comet`.

## Answer to the core question

> right now we don't even have selectable text. would this be enough to add support for that?

**Yes.** Comet's selection code is self-contained, pure, unit-tested, and every GPUI API it
needs already exists in our pinned revision `d5dc01f`:

| API used by Comet selection | Present in our gpui? | Location |
|---|---|---|
| `StyledText::layout() -> TextLayout` | yes | `crates/gpui/src/elements/text.rs:391` |
| `TextLayout::index_for_position` | yes | `text.rs:830` |
| `TextLayout::position_for_index` | yes | `text.rs:864` |
| `TextLayout::bounds` / `line_height` | yes | `text.rs:930`, `935` |
| `window.on_mouse_event` | yes | `window.rs:4824` |
| `window.on_key_event` | yes | `window.rs:4847` |
| `canvas()` + `window.paint_quad(quad(..))` | yes | `elements/canvas.rs` |
| `cx.write_to_clipboard` | yes in gpui, **stubbed in our platform** | `app.rs:1417` vs `node_platform.rs:699` |

The one real blocker is our own code: `NodePlatform::write_to_clipboard` is an empty function.

## What Comet actually gives us

```
tmp/comet/crates/
├── ui/src/markdown/
│   ├── selection.rs          pure selection state (300 lines, no gpui)
│   ├── render.rs             BlockTree → gpui (1408 lines)
│   │   └─ ~230 lines: selection paint/registry half
│   ├── parser.rs             pulldown-cmark → BlockTree (1190 lines)
│   ├── mend.rs               repair half-streamed markers (413 lines)
│   └── veil.rs               opacity fade for streaming (508 lines)
├── ui/src/changes.rs         unified diff: parse + virtualize (4364 lines)
├── ui/src/syntax_cache.rs    LRU cache for highlights (199 lines)
└── syntax/src/lib.rs         Tree-sitter → HighlightSpan (1167 lines)
```

License is MIT, so a port with attribution is fine. `THIRD_PARTY_NOTICES.md` lists the
Tree-sitter grammar licenses we would inherit.

## Two approaches

### Approach A — native custom elements only

Add `<markdown>`, `<diff>`, `<code-block>` as `CustomElement` implementations. Fast to ship, matches
Comet closely, but selection stays **trapped inside those elements**. A user's own
`<div><text>hello</text></div>` is still unselectable, and a drag cannot cross from a markdown
block into a plain label. That is the wrong shape: selection is a property of *text*, not of a
widget.

### Approach B — selection in the core renderer, then components on top (recommended)

Make **every** text node in GPUIX render through `StyledText` + a selection-aware underlay.
Selection then works across the whole tree for free, including inside future `<markdown>` and
`<diff>` elements, because they paint into the same frame-ordered registry.

This is exactly how Comet does it. The doc comment in `selection.rs:1-14` says it plainly:

> Zed's markdown selects continuously because its whole document is ONE element over one text
> model; zeron renders a TREE of text elements inside a virtualized list, so this module rebuilds
> that continuity.

GPUIX is a tree of text elements too. Same problem, same solution.

**Recommendation: Approach B.** Stage 1 alone (selectable text) is the highest-value, lowest-risk
piece and unblocks everything else.

## How selection works

```
 GpuixView::render
        │
        ├─► selection_frame_reset()  ──► canvas paints FIRST, clears REGISTRY
        │
        └─► build_element(root)  ──► depth-first, so paint order IS document order
                   │
                   ▼
           build_text(id=7, "hello world")
                    │
         ┌──────────────────────────────────────────────────┐
         │ div().relative()                                 │
         │   ├─ canvas() (UNDERLAY for selection wash)      │
         │   │    ├─ paint: wash quads from wash_range()    │
         │   │    ├─ paint: REGISTRY.push({key, layout})    │
         │   │    └─ on_mouse_event: down/move/up           │
         │   └─ StyledText::new(text).with_runs(runs)       │
         └──────────────────────────────────────────────────┘

  Mouse down  ►  layout.index_for_position(pos)  ►  selection::begin(key, byte_ix)
  Mouse move  ►  registry_point(pos) → (element_ix, byte_ix)
              ►  selection::resolve_spans(registry, anchor, head)  ►  window.refresh()
  Mouse up    ►  selection::end_drag(key)  ►  joined text
  Cmd+C       ►  selection::selected_text()  ►  cx.write_to_clipboard(..)
```

The registry is a `thread_local Vec<RegEntry>` rebuilt every frame during paint. A drag anchored
in element A resolves against that frame's registry, producing **partial spans** in the anchor
and head elements and **whole spans** for everything between. Copy joins spans with `\n`.

`range_rects` (`render.rs:920-973`) turns a byte range into one wash quad per visual line, using a
binary search over glyph positions to find soft-wrap boundaries. That function is the trickiest
80 lines in the whole port and it is worth taking verbatim.

---

# Stage 0 — clipboard in NodePlatform

**Blocker for Stage 1.** Cmd+C cannot work while the platform swallows it.

Files:
- `packages/native/src/platform/node_platform.rs:695-699` — replace the stubs.

Add `arboard = "3"` to `packages/native/Cargo.toml`. Hold a lazily-created
`arboard::Clipboard` in a `RefCell` on `NodePlatform` (it is `!Send`, which is fine because
`NodePlatform` already lives in a `thread_local`).

Tests:
- `packages/native/src/platform/node_platform.rs` — a `#[cfg(test)]` round-trip
  (`write_to_clipboard` then `read_from_clipboard`). Skip on CI Linux without a display server by
  gating on `DISPLAY`/`WAYLAND_DISPLAY`.

---

# Stage 1 — selectable text in the core renderer

The centrepiece. After this, all GPUIX text is selectable and copyable.

## New files

`packages/native/src/text/selection.rs` (~300 lines)
: Near-verbatim port of `tmp/comet/crates/ui/src/markdown/selection.rs`. Pure state, no gpui
  imports, keeps its own unit tests (`resolve_spans`, `word_range`, drag lifecycle). One change:
  replace the process-global `OnceLock<Mutex<Option<MdSelection>>>` with a field on `GpuixView`,
  passed by `&mut`. Comet can afford a global because it is one app; GPUIX is a library and a
  process may host more than one renderer.

`packages/native/src/text/paint.rs` (~250 lines)
: The gpui half, lifted out of `render.rs:643-973`:
  `range_rects`, `RegEntry`, `REGISTRY`, `registry_point`, `resolve_drag`,
  `register_selection_listeners`, `paint_text_selection`, `selection_frame_reset`.
  Plus one addition Comet does not need: a `window.on_key_event` listener that copies on
  `cmd-c` / `ctrl-c`, since GPUIX has no keymap or action system.

`packages/native/src/text/mod.rs`
: Re-exports, plus `selectable_text_element(text, runs, key, theme) -> AnyElement` — the single
  helper both `build_text` and `build_div` call.

## Changed files

`packages/native/src/renderer.rs`
- `build_text` (line 989): drop the raw-string fast path at 1002-1008. Always build
  `StyledText` + underlay. The style-derived color/size/weight stay on the wrapper div, so the
  `TextRun` only needs `font` + `color`.
- `build_div` (line 968): route `element.content` through the same helper instead of
  `el.child(content.clone())`.
- `GpuixView::render` (line 515): wrap the built root in
  `div().size_full().child(selection_frame_reset()).child(result)`.
- `GpuixView`: add `selection: SelectionState` field.
- New napi methods on `GpuixRenderer`: `getSelectedText() -> Option<String>` and
  `clearSelection()`.

`packages/native/src/style.rs` + `packages/react/src/types/host.ts`
- New style prop `userSelect: "text" | "none"` (default `"text"`). `"none"` skips registry
  registration and mouse listeners, so buttons and toolbars do not start drags.

`packages/react/src/types/host.ts`
- New event `onSelectionChange?: (event: EventPayload) => void` on the root, carrying the joined
  selected text. Emitted from `end_drag`.

## Risks

- **Extra wrapper div per text node.** `div().relative()` around every text node changes the
  layout tree shape. Flex children counts change for anyone relying on `nth-child`-like
  positioning; we have no such selectors, so impact should be nil, but styles tests must be
  re-snapshotted.
- **`window.on_mouse_event` in the test renderer.** Our `TestGpuixRenderer` uses
  `simulate_mouse_down/move/up`. Frame-scoped window listeners registered during *paint* only
  exist after a paint pass, so the test must `flush()` before simulating. Needs verification
  early; if window-level listeners do not dispatch in the test context, Stage 1's test story
  falls back to the visual screenshot renderer.
- **Performance.** One extra canvas element per text node. Comet ships this in a virtualized
  list, so it is viable, but our examples render hundreds of unvirtualized `<text>` nodes
  (`examples/diff.tsx` is 927 lines of exactly that). Stage 6 (`<list>`) is the real fix.

## Tests

- `packages/native/src/text/selection.rs` — port Comet's 5 unit tests as-is.
- `packages/react/src/__tests__/selection.test.tsx` — new. Render text, `simulateMouseDown` at
  x1, `simulateMouseMove` to x2, `simulateMouseUp`, assert `getSelectedText()`. Cover:
  single-element drag, cross-element drag, reversed drag, double-click word select,
  triple-click line select, `userSelect: "none"` opting out.

---

# Stage 2 — Tree-sitter syntax highlighting

## New workspace crate

`packages/native-syntax/` — vendored from `tmp/comet/crates/syntax/src/lib.rs` (1167 lines).

Its public contract is deliberately colour-free, which is exactly what we want because the
palette must come from JS:

```rust
pub enum HighlightKind { Comment, Keyword, String, Number, Function, Type, /* 24 total */ }
pub struct HighlightSpan { pub range: Range<usize>, pub kind: HighlightKind }
pub struct HighlightedDocument { pub lines: Vec<Vec<HighlightSpan>> }

pub fn highlight(request: HighlightRequest) -> Result<HighlightedDocument, HighlightError>;
pub fn language_for_path(path: &str) -> Option<LanguageId>;
pub fn detect_language(path: Option<&str>, fence_tag: Option<&str>, first_line: Option<&str>) -> Option<LanguageId>;
```

**Compile time is the concern.** Comet pins 28 Tree-sitter grammars. Cut that with cargo
features:

```toml
[features]
default        = ["syntax-web", "syntax-systems"]
syntax-web     = ["ts", "tsx", "js", "json", "css", "html", "md", "yaml", "toml"]
syntax-systems = ["rust", "go", "python", "bash", "c"]
syntax-all     = [/* everything Comet ships */]
```

## Highlight cache

Port `tmp/comet/crates/ui/src/syntax_cache.rs` (199 lines) into
`packages/native/src/syntax_cache.rs`. Bounded LRU, 96 documents / 24 MiB. Its own doc comment
records the key lesson worth keeping:

> Colors and GPUI runs deliberately stay outside this cache so appearance changes recolor
> existing spans without parsing again.

## Run building

Port `runs_for_syntax_line_with_plain` (`render.rs:1175-1206`) into
`packages/native/src/text/runs.rs`. Its invariant — every run uses the **same font**, only the
colour differs — is what makes highlighting layout-free, so highlight results can arrive late
without reflowing anything.

Tests: port Comet's `code_line_runs_cover_exactly` and
`tree_sitter_runs_are_rich_and_paint_only`, which assert runs sum to `line.len()` and never
change fonts.

---

# Stage 3 — `<code-block>` custom element

The smallest useful native element, and a de-risking step for Stages 4 and 5.

`packages/native/src/custom_elements/code.rs`, registered in
`custom_elements/mod.rs:with_defaults()`.

```tsx
<code-block
  code={source}
  language="typescript"          // or path="src/app.ts" for detection
  showLineNumbers
  theme={{ keyword: '#f38ba8', string: '#a6e3a1', comment: '#6c7086' }}
  onCopy={(e) => {}}
/>
```

Rendering follows `render_code_block` (`render.rs:1001-1154`): one `div` per line at an exact
`lineHeight` so total height is `lines × lineHeight` and never shifts when highlighting lands;
`overflow_x_scroll` on the body; `whitespace_nowrap`.

Highlighting runs synchronously on first render, then goes through the Stage 2 cache. Comet
pushes it to `cx.background_executor()`; we should **not** copy that yet, because our frame loop
is driven from Node's event loop via `tick()` and background completion has no clean way to
request a repaint. Do it synchronously with a source-size cap first, and revisit once the
notification path exists.

Tests: `packages/react/src/__tests__/code.test.tsx` — assert rendered line count, that
`getAllText()` matches input lines, and that selection spans across lines.

---

# Stage 4 — `<diff>` custom element

Replaces `examples/diff.tsx` (927 lines of JS building thousands of divs, with shiki doing
highlighting in JS) with a native element.

## Port from `changes.rs`

Data model (`changes.rs:69-178`) — take verbatim:

```rust
pub enum LineKind { Context, Add, Del, Meta }
pub struct DiffLine { kind: LineKind, old_no: Option<u32>, new_no: Option<u32>, text: String }
pub struct Hunk { header: String, lines: Vec<DiffLine> }
pub enum FileStatus { Added, Deleted, Modified, Renamed }
pub struct FileDiff { path, old_path, status, binary, notices, hunks, additions, deletions, max_line }
```

`parse_patch` (`changes.rs:259-388`) — a unified-diff parser handling `diff --git`, hunk headers,
rename and mode lines, and binary markers.

Row flattening + virtualization (`changes.rs:824-983`, `3577-3725`): a flat `Vec<DiffRow>` fed to
gpui `list()` with `ListState::reset_with_uniform_height(rows.len(), px(21.0))`. Collapsing a
file **removes** its body rows rather than hiding them, and `ListState::splice` keeps the scroll
anchored.

Row rendering (`changes.rs:3104-3235`): accent bar, two gutters, marker column, then
`StyledText::new(line.text).with_runs(runs)`.

## What we add beyond Comet

- **Word-level intra-line diff.** Comet has none; our current JS example does. Add it with the
  `similar` crate (already a Comet dependency, used elsewhere in `transcript.rs:430-495`) and
  paint word washes as quads in the same underlay canvas that draws the selection wash.
- **Split view.** Comet is unified-only.

## API

```tsx
<diff
  patch={unifiedDiffString}
  view="unified"                 // | "split"
  collapsedPaths={['pnpm-lock.yaml']}
  wordDiff
  theme={diffTheme}
  onToggleFile={(e) => {}}
  onLineClick={(e) => {}}
/>
```

Tests: `packages/react/src/__tests__/diff.test.tsx`. Port the useful assertions from
`examples/diff.test.tsx`, plus Rust unit tests for `parse_patch` against fixtures (rename,
binary, no-newline-at-EOF, mode change).

---

# Stage 5 — `<markdown>` custom element

Depends on Stage 3 for code fences.

Port, in order:

1. `parser.rs` (1190 lines) — `pulldown-cmark 0.12` with
   `ENABLE_TABLES | ENABLE_STRIKETHROUGH | ENABLE_TASKLISTS`, plus a custom autolink pass for bare
   `http(s)://` URLs. Yields `BlockTree { blocks: Vec<TopBlock> }`.
2. `render.rs` block half (~700 lines minus the selection code already taken in Stage 1) —
   headings, lists with real 5px disc markers, blockquotes with an accent rail, GFM tables with
   Taffy-resolved column widths, rules. Links become clickable via `InteractiveText`.
3. `mend.rs` (413 lines) — repairs half-streamed inline markers so `**bold` styles immediately
   instead of showing literal asterisks that vanish later and reflow the paragraph.
4. `veil.rs` (508 lines) — per-chunk opacity fade-in for streaming text, paint-only.
5. `IncrementalParser` + `RenderCache` — only needed for streaming; ship static rendering first.

## API

```tsx
<markdown
  source={text}
  streaming                      // enables mend + veil + incremental parse
  theme={mdTheme}
  onLinkClick={(e) => {}}
/>
```

The streaming pieces (3, 4, 5) are a large chunk of work for a narrow use case. **Ship 1 + 2
first**, then add streaming only if an actual app needs it.

Tests: `packages/react/src/__tests__/markdown.test.tsx` — headings, lists, tables, code fences,
links, and selection dragging across blocks. Rust unit tests for the parser can be ported wholesale.

---

# Stage 6 — `<list>` virtualization primitive

Stages 4 and 5 both need it, and it fixes the performance cost Stage 1 introduces.

GPUI's `list()` wants a closure that builds row N on demand. Because GPUIX keeps a retained tree
in Rust, we do **not** need a JS round trip: `<list>` can simply build only the children whose
indices fall in the visible range.

```tsx
<list itemHeight={21} overscan={1024} onVisibleRangeChange={(e) => {}}>
  {rows.map((row) => <div key={row.id}>...</div>)}
</list>
```

Caveat: React still creates every child element in the retained tree, so this virtualizes
**GPUI element construction and paint**, not tree size. That is the expensive half, so it is
still a large win, but it is not the same as windowing in React.

---

# Suggested order

```
Stage 0  clipboard              small    ──┐
Stage 1  selectable text        large    ──┴─► text is selectable + copyable
Stage 2  tree-sitter syntax     medium   ──┐
Stage 3  <code-block>           medium   ──┴─► native code blocks
Stage 6  <list>                 medium   ────► needed before diff/markdown
Stage 4  <diff>                 large    ────► replaces examples/diff.tsx
Stage 5  <markdown> (static)    large
Stage 5b <markdown> (streaming) large    ────► only if an app needs it
```

Stages 0 + 1 are worth doing on their own even if nothing else follows. Everything after them is
optional and independently useful.

# Attribution

Ported files must carry a header pointing at the source, for example:

```rust
//! Text selection, ported from Comet (https://github.com/zeronsh/comet), MIT.
//! Original: crates/ui/src/markdown/selection.rs
```

Add a `THIRD_PARTY_NOTICES.md` at the repo root once Stage 2 pulls in Tree-sitter grammars.
