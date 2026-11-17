# Editing hosts, ranges and the node selection

`contenteditable` is the DOM model of an editing surface: which elements are editable, which of them take focus, a live `Range` over the DOM, a `Selection` of nodes, and the Input Events an edit fires. It exists so an editor written for the web (Lexical is the target) runs unchanged. Phase 1 is the model and the event sequence; the caret and the selection are not painted, and a click does not place one ([deviations.md](deviations.md#events-and-input)). The API an app author sees is in [reference.md](../reference.md#editing-hosts).

## Editable elements and editing hosts

An element's own `contenteditable` is `true` (an empty text too), `false` or `plaintext-only`, ASCII case-insensitive, or it has none (no attribute, or a text that is no keyword) and takes its parent's. An editing host is an editable element whose parent is not editable. Two modules keep the same rule, one per side:

- `js/editing/host.ts` answers `isContentEditable`, `editingHostOf(node)` and `isEditingHost(element)`. `contentEditable` itself is reflected in `js/dom/reflected-members.ts`.
- `src/html/editing.rs` answers `own_value`, `is_editable` and `is_editing_host` from the props native holds (React writes `contentEditable`, Solid and `setAttribute` write `contenteditable`; `is_prop` names both).

**Focus.** An editing host is focusable, with `tabIndex` 0, and nothing inside it is: the editable descendants take no focus of their own. `RetainedTree::takes_focus` adds "is an editing host" (and has a box: a `display: contents` element is not one) to `needs_focus`, and `focusable_ids` holds the result. What decides it is the *parent's* editability, so it is not a function of the element's own props: it moves with a prop write on any ancestor and with a reparent.

- A `contenteditable` write retracks the element's subtree (`track_focusable_subtree` in `set_custom_prop`).
- A reparent retracks the moved subtree in `append_child`, `insert_before` and `detach_child` while `editable_count` is non-zero, the count of elements with their own `contenteditable` (as `inert_count` gates the same retrack for `inert`). React writes an element's props before it appends it, so `<div contentEditable><p contentEditable/></div>` registers the `<p>` as a host while it has no parent, and only the append makes it a descendant.
- Every element whose focusability flips in a retrack is `mark_render_changed`: nothing in its own props changed, so a retained root holding it would otherwise replay the tab stop and focus registration it had ([retention.md](retention.md)).

**Keys.** A focused element that is editable (a host, or anything inside one) leaves the arrow keys, Page Up and Down, Home, End and Space to editing, as a focused `<input>` or `<textarea>` does: `GpuixView::scroll_by_key` does not scroll for it (`html::editing::is_editable`).

**`:read-write` and `:read-only`.** `:read-write` matches an editable element as well as the text controls, in `js/dom/selectors.ts` and in `src/css/sheet/tree_states.rs`; a `contenteditable` write refreshes the states below the element (`sheets_tree_state_changed_below`).

## Ranges

`js/dom/range.ts` has `AbstractRange`, `StaticRange` and `Range` with the standard's boundary-point algorithms (`js/dom/tree-order.ts` for the position of two nodes). `getBoundingClientRect` and `getClientRects` of a `Range` are interim: they give the start container's element rect.

A `Range` is live: a change to the tree moves its boundary points as the standard says. `js/dom/live-ranges.ts` holds the ranges weakly and implements the steps: `liveRangesBeforeRemove(parent, child, index)` before a child leaves, `liveRangesAfterInsert(parent, index, count)` after children arrive, `liveRangesReplaceData(node, offset, count, addedLength)` for a text change, and `liveRangesSplitText`. Each returns at once while no range exists (`hasLiveRanges()`), so a page that never makes one pays a counter check per tree change.

### The adapter contract

Children and text live in adapter mirrors, not in the node classes, so the node classes cannot see every change. **Every child or text mutation an adapter makes calls the hook exactly once, and a path that is reached through the DOM API must not call it again.** One missing call leaves a range pointing at a stale index; two move it twice.

| Change | Where the hook is called | Hook |
|---|---|---|
| A child is added (a framework commit, `appendChild`, `insertBefore`, a fragment) | React `linkChild` (`react/src/reconciler/host-nodes.ts`); Solid `insertHostNode` (`solid/src/host.ts`), after the splice | `liveRangesAfterInsert(parent, index, 1)` |
| A child is removed (including the removal half of a move) | React `unlinkChild`; Solid `removeFromParent`, before the splice, with the old index | `liveRangesBeforeRemove(parent, child, index)` |
| Text data through the DOM (`data`, `appendData`, `insertData`, `deleteData`, `replaceData`, `textContent`) | `replaceData` in `js/dom/nodes.ts`, once, before `binding.setData` | `liveRangesReplaceData(node, offset, removed, added)` |
| Text data the framework commits without the DOM API | React `commitTextUpdate` (`host-config.ts`); Solid's universal `replaceText` (`universal.ts`) | `liveRangesReplaceData(node, 0, oldLength, newLength)` |
| `Text.splitText` | `nodes.ts`, after the new node is inserted | `liveRangesSplitText` |

The DOM-path setters are the other half of the rule: React `setDomTextData` (`dom-mutation.ts`) and Solid `replaceHostText` (`host.ts`) are what `binding.setData` calls after `replaceData` has notified, so they must not notify. The framework paths bypass `replaceData` and so notify for themselves. A new adapter, or a new way an adapter changes a child or a string, keeps one call per change.

## The node selection

`js/dom/selection.ts` is the one `Selection` of the app, and it is one of two things: a live `Range` over the DOM (after `collapse`, `setBaseAndExtent`, `addRange`, `modify` or the caret of an editing host) or the painted-text selection a drag makes. They never exist together: selecting nodes clears the painted text and the drag drops the range. The range the selection owns is registered as a live range, and a boundary moved by a tree or data change makes it dispatch `selectionchange` (one per task, only while a listener exists). `Selection.modify` and the deletion keys read text through `js/dom/selection-movement.ts` and `text-segmentation.ts`: grapheme and word steps over the Text nodes around a point, a block edge or `<br>` as one step, a `contenteditable="false"` element as one atomic stop. It has no layout, so `line` and the other layout granularities throw.

**The caret goes in at focus.** A caret is placed at the start of an editing host, unless the selection is already inside it, whenever focus moves into the host:

- `element.focus()` does it in `focusHostElement` (`js/focus.ts`).
- Focus that native moved (Tab, Shift+Tab, a click) does it where JS first hears of it: `createRendererState`'s `dispatch` and `dispatchSync` call `placeCaretOnFocusIn` on a `focusin` before the event is delivered, so a listener sees the selection. A click behaves like Tab for now; phase 2 puts the caret at the point.

## The editing input sequence

`js/editing/input.ts` runs one edit: `beforeinput` (an `InputEvent` that bubbles, is cancelable and composed, at the host, with `targetRanges`), the change to the DOM, `input`. The change goes through the DOM members (`insertData`, `deleteContents`, `insertNode`), so a `MutationObserver` records it, live ranges and the selection follow, and a framework editor sees what it would see in Chrome. `js/events/keyboard-defaults.ts` starts it from an unprevented `keydown` on a focused editing host; a composition is `compositionstart`, `beforeinput`, `compositionupdate`, the change, `input`, `compositionend`. The test renderer drives it without a key: `simulateEditingInput` and `simulateEditingComposition` (`js/testing.ts`). Phase 1 edits text only: a paragraph or line break fires `beforeinput` and changes nothing, and so does an edit that would join blocks or remove an element.

## Tests

- `packages/native/js/__tests__`: the range, live-range, selection, `content-editable` and editing-input unit tests.
- `packages/react/src/__tests__/content-editable.test.tsx` and `content-editable-nesting.test.tsx`, the Solid twins: the reflected property, host focus, nesting and reparenting, the scroll keys.
- `src/retained_tree.rs` unit tests: `an_editing_host_is_focusable_and_its_editable_descendants_are_not`, `an_editable_element_is_a_host_only_by_where_it_is_put`, `a_descendant_whose_focusability_flips_with_an_ancestor_is_marked_changed`.
- `examples/lexical`: Lexical itself, mounted, typed into and undone, for React and Solid.
