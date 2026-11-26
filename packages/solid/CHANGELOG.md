# @ghia/solid

## 0.14.0

`contenteditable` and the DOM editing model are in, so Lexical runs unchanged: editing hosts, live ranges, `Selection`, `beforeinput`, clipboard and paste events, and an Edit menu. Scrolling and text are faster (scroll pixel reuse, a per-glyph advance cache), a scroll no longer freezes when frames outlast a vsync, and stylesheets gain structural, form-state and `:has()` selectors. `<code code=... language=...>` is renamed `<code-block>`.

### Breaking changes

- **`<code code=... language=...>` is now `<code-block ...>`, and `<code>` is HTML's inline element.** The syntax-highlighted block keeps its props (`code`, `language`, `path`, `showLineNumbers`, `theme`) under the new name, so rename the tag (`<code-block code={source} language="ts" />`), the JSX type `CodeProps` to `CodeBlockProps`, and `findByType("code")` to `findByType("code-block")`. A `<code>` now lays out as `<span>` with the user agent style of Chrome's `code`: the generic `monospace` family, drawn at 13px beside 16px text by Chrome's monospace size rule (see `docs/reference.md`, "Monospace size"), so code that renders text inline in a paragraph (Lexical's Code format) works unchanged.
- **`pre`, `kbd` and `samp` use the generic `monospace` at Chrome's size**, not `Menlo` at the inherited size: they are 13px where the text around them is 16px, unless an absolute `font-size` is inherited or the `font-family` is a longer list (`monospace, monospace`). `tt` is a tag too.
- **`writeClipboardText` and `readClipboardText` on the renderer are `writeClipboard(items)` and `readClipboard()`.** Renderer code that called the old pair moves to the new one, which carries several types (see Clipboard below); `navigator.clipboard.writeText` and `readText` run on top of it.
- **A scroll no longer moves the hover under a pointer that stays, as in Chrome.** `:hover`, `style.hover` and `pointerover`/`pointerenter`/`mouseover`/`mouseenter` (and their out and leave twins) stay on the element the pointer last moved onto while a wheel runs, and follow to what is under it 500 ms after the last tick of a mouse wheel, 100 ms after a trackpad lift (momentum that follows runs the 500 ms again), at the next frame after code scrolls an element by any path (`scrollTop = n`, `scrollTo`, `scrollIntoView`, `scrollToItem`, a key, a scrollbar; a smooth scroll when it ends), or at the next frame after a frame that changed the page (a commit, a restyle, a resize) or ran an animation of the layout (a transition or animation of a size, a margin, a position or the like, or a `layout` glide; a color, an opacity or a transform does not count, so `transition-colors` on rows and a spinner leave the hover where the wheel put it). A pointer that moves follows at once. `getPatchCounters().scrollPatch` loses `hoverAsked` and `hoverMatters` and its `held` loses `HitboxChain`; `Hover` holds a frame for a pointer that moved only. A test that wheels and expects the row under the pointer to be hovered calls `advanceTime(500)` and draws the frames the follow asks for.

### Features

**Editing and contenteditable**

- `contentEditable` is the DOM's: it reflects the `contenteditable` attribute, `isContentEditable` reads it with inheritance, an editing host is focusable (`focus()`, Tab, `tabIndex` 0), and `:read-write` / `:read-only` count editable elements. Nothing edits yet.
- Typing into an editing host (`<div contentEditable>`): what the keyboard types, a dead key's result, the emoji picker and dictation reach the focused host through the window's input handler, once, as `beforeinput` (an `InputEvent` that bubbles and can be canceled: `insertText`, or `insertReplacementText` for a range the platform replaces), the change to the DOM, then `input`. An unprevented Enter, Backspace or Delete `keydown` does the same, keeps the platform from typing the key as well, and an editing host always gets its `keydown`, with no listener on its path. The edit goes through `insertData` and `deleteContents` so a `MutationObserver` sees it and the selection follows. `InputEvent` has `targetRanges` and `getTargetRanges()`. The test renderer has `simulateEditingInput` and `simulateEditingComposition`.
- An input method composes in a focused `contenteditable`: marked text, a dead key (Option+E, then E) and a commit fire `compositionstart`, `beforeinput` (`insertCompositionText`), `compositionupdate`, `input` and `compositionend` in Chrome's order, and the platform is told where the marked text is (the candidate window) and which character a point is on. The composition ends with `compositionend` when the host loses focus. `simulateComposition` now composes in an editing host through the same text input, and the test renderer has `getInputMethodBounds` and `getInputMethodIndexAtPoint`.
- A focused `contenteditable` host moves the caret and deletes by word and line from the keyboard, as Chrome on macOS does: Left and Right by character (a range collapses to its edge), Option by word, Cmd to the row boundary; Up and Down by painted row keeping the column, Cmd to the start or end of the host; Shift extends each, and Shift+Home and Shift+End extend to the host's edges. Cmd+A selects the host's contents, the Emacs moves Ctrl+B, F, N, P extend with Shift, Ctrl+H and Ctrl+D delete, and Option+Backspace, Option+Delete and Cmd+Backspace fire `beforeinput` with `deleteWordBackward`, `deleteWordForward` and `deleteSoftLineBackward` and `targetRanges` before they change the DOM. Each is a `keydown` default, so `preventDefault()` stops it. Bindings Ghia does not do are listed in `docs/fork/deviations.md`. Home, End, Page Up and Page Down scroll the nearest scroller while a host has focus (the arrow keys and Space stay editing keys and do not scroll, and Shift+Page Up and Down scroll nothing).
- A click in a `contenteditable` host puts the caret at the character under the pointer and focuses the host with the selection already there, Shift+click extends the focus, and a drag selects from the press to the pointer, clamped to the host. A double click selects the word, a triple click the contents of the paragraph, and a drag after either extends by words or paragraphs. The selection is a node selection, so it is painted as the caret or the wash, `selectionchange` fires and a framework editor (Lexical) reads it; a prevented `mousedown` changes nothing, and a press outside every editing host still selects painted text. No auto-scroll at the edge while dragging in a host and no `selectstart` yet: see `docs/fork/deviations.md`. A press, a drag or a double or triple click on an empty paragraph (`<p><br></p>`) puts the caret in it, as `(paragraph, 0)`.
- Editing hosts follow the DOM at the edges: moving an editable subtree into or out of an editing host updates what takes focus (an editable element inside an editable parent is not a tab stop), and Tab or `focus()` into a host puts the caret at its start (a click focuses first, then puts it at the point). Setting the selection inside a host that does not hold focus (`setBaseAndExtent`, `collapse`, `addRange`, ...) focuses the host, as Chrome does, so Lexical's `editor.focus()` moves focus into an editor. A host matches `:focus-visible` after a click, as in Chrome, and a focused `contenteditable` host dims no other focusable element, as a text field does not.
- The caret of an editing host is painted: a collapsed selection inside a focused `contenteditable` in a key window draws a 2px caret a row high in the theme's caret colour, solid when it moves or comes and blinking every 500 ms like an `<input>`'s. A blink is a patched frame that builds only the paragraph that holds the caret, and a host that has no focus or a window that is not key asks for no frame. `getPaintedNodeSelection()` in the test renderer now returns `{ washes, caret }`.
- A node selection inside an editing host is painted: the text between its two points gets a selection wash in every paragraph it reaches, in the colour of a dragged selection. Changing the selection builds only the paragraphs it touches (retention skips the rest). The selection goes to native in the mutation batch (`setNodeSelection`, wire opcode 16).

**Ranges, selection and the DOM from code**

- `Range`, `StaticRange` and `AbstractRange` exist, with `document.createRange()`. A `Range` is live: a tree change, including a React or Solid insert, removal or text update, and a data change move its boundary points as the DOM standard says. `CharacterData` has `substringData`, `appendData`, `insertData`, `deleteData` and `replaceData`, `Text` has `splitText` and `wholeText`, and `document.hasFocus()` answers.
- `getSelection()` holds a live `Range` of nodes once code selects them: `anchorNode`, `focusNode`, `direction`, `getRangeAt`, `addRange`, `removeRange`, `collapse`, `extend`, `setBaseAndExtent`, `selectAllChildren`, `containsNode`, `deleteFromDocument`, `getComposedRanges` and `modify` by character and word, with the DOMExceptions of the standard. A node selection and the painted text a drag selects replace each other. `document` hears one coalesced `selectionchange` per burst of changes, including a move caused by a tree or data change.
- `Range.getClientRects()` and `getBoundingClientRect()` are the rects of the selected text, one for each painted line of each Text node and the border box of each element the range selects whole, and a collapsed range in text is the caret rect. `document.caretPositionFromPoint(x, y)` (with the `CaretPosition` global) and `document.caretRangeFromPoint(x, y)` give the text position nearest a point. `Selection.modify` takes the `line`, `lineboundary` and `documentboundary` granularities: moves by line keep the caret's x across a short line. Native has three new reads for them (`getTextRangeRects`, `caretPositionFromPoint`, `moveCaretVisually`).
- `document.createDocumentFragment()` makes a real `DocumentFragment`: it holds children, is never mounted, and inserting it (`appendChild`, `insertBefore`, `replaceChild`, `append`, `before`, `Range.insertNode`, ...) moves its children in order. `Range.cloneContents()`, `extractContents()` and `surroundContents()` are there.
- `DOMParser` parses `text/html` into an inert `Document` (real `Element`, `Text`, `Comment` and `DocumentFragment` nodes with `style`, `querySelector`, `<template>` content and a `styleSheets` list of `CSSStyleSheet`s built from its `<style>` elements; `CSSStyleRule.style` reads a rule's declarations), and `innerHTML`, `outerHTML` and `insertAdjacentHTML` read and write markup on an element, in its context, so the new children are drawn. HTML is parsed and serialized by parse5 through a tree adapter over Ghia's own nodes. `Comment`, `StyleSheetList` and `Element.namespaceURI` are there; `textContent` skips comments. The XML MIME types and `XMLSerializer` are not supported: `docs/fork/deviations.md`.

**Clipboard**

- `DataTransfer`, `DataTransferItemList`, `DataTransferItem` and `ClipboardEvent` are globals. `new DataTransfer()` is an empty read/write store with `items`, `types`, `files`, format normalisation and the DOM's read-only and protected modes, and the `dataTransfer` of a drag is an instance of it. `copy`, `cut` and `paste` are `ClipboardEvent` types with `onCopy`, `onCut` and `onPaste` props in React and Solid.
- Cmd+C, Cmd+X, Cmd+V and Cmd+A, and a new Edit menu (Cut, Copy, Paste, Select All), run as one set of GPUI actions. Outside an `<input>` or `<textarea>` they fire the DOM `copy`, `cut` and `paste` events at the element that holds the start of the selection (the focused element with no selection), with a `DataTransfer` in the mode the Clipboard API gives it; a cancelled `copy` or `cut` writes exactly what the handler put in `clipboardData`, and an uncancelled `copy` writes `text/plain` (line breaks between blocks and at a `<br>`, as Chrome copies it) and `text/html` of the node selection (a text selected by dragging is still copied as before). A checkbox, radio, range or hidden `<input>` is not a text control: it gets the events. A `preventDefault` on the `keydown` cancels the command. Select All selects the focused editing host, or the body. In an editing host, an uncancelled Cut copies the selected range and deletes it (`beforeinput` `deleteByCut`, then `input`), and an uncancelled Paste inserts the clipboard's text (`beforeinput` `insertFromPaste` with `dataTransfer` and `targetRanges`, a `<br>` for each line break, `input`); a caret, or a selection outside a host, does nothing, and so does a clipboard with no text after the `paste` event. `Element.innerText` is new. `document.execCommand('copy' | 'cut' | 'selectAll')` run the same commands synchronously (an `execCommand` cut fires no `beforeinput`, and a call made from the event of another returns false), `'paste'` and every other command return false, and `queryCommandSupported` and `queryCommandEnabled` answer for them. `TestRenderer.simulateMenuAction(name)` chooses an Edit menu item. `<input>` and `<textarea>` fire no clipboard events: `docs/fork/deviations.md`.
- The clipboard carries several types. `writeClipboard(items)` and `readClipboard()` on the renderer replace `writeClipboardText` and `readClipboardText`: `text/plain`, `text/html` and `text/uri-list` use their pasteboard types, and every other type, such as `application/x-lexical-editor`, goes into Chrome's `org.chromium.web-custom-data` entry, so a page here and a page in Chrome exchange them. `navigator.clipboard.writeText` and `readText` run on top, and the test renderer holds the entries in memory.

**Stylesheets**

- Stylesheets support the structural pseudo-classes: `:first-child`, `:last-child`, `:only-child`, `:nth-child(An+B)`, `:nth-last-child(An+B)`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type(An+B)`, `:nth-last-of-type(An+B)` and `:empty`, in any compound and inside `:is()`, `:where()` and `:not()`. Before, a rule that used one was dropped. A child that comes, goes or moves restyles only the siblings whose position it changes (the two neighbours for `:first-child` and `:last-child`, the siblings after it for `:nth-child()`, before it for `:nth-last-child()`, the parent for `:empty`), and a sheet that uses none of them marks nothing extra. `:nth-child(An+B of S)` is still not supported.
- Stylesheets support the form and tree state pseudo-classes `:disabled`, `:enabled`, `:checked`, `:indeterminate`, `:required`, `:optional`, `:read-only`, `:read-write`, `:any-link` and `:link`, in any compound and inside `:is()`, `:where()` and `:not()`. Before, a rule that used one was dropped. A prop or a click that changes one of them restyles only the elements that read it (toggling `disabled` on one of a thousand buttons matches that button again; checking a radio matches it and the radio it unchecked), and a sheet that uses none marks nothing extra. `:placeholder-shown`, `:invalid`, `:valid`, `:default`, `:open`, `:autofill` and the range pseudo-classes are still not supported.
- Stylesheets support `:has()`: `:has(> img)`, `:has(+ p)`, `:has(~ .x)` and `:has(.err)` (a relative selector list, with `>`, `+`, `~` or a descendant as the leading combinator), in any compound and inside `:is()`, `:where()` and `:not()`, so `.card:has(.err) .title`, `.btn:has(> svg)`, `h1:has(+ p)` and `.field:has(input:checked) .label` style what they name. Before, a rule that used it was dropped. A class, id, attribute, tree state or position an argument reads, and a child that comes, goes or moves, restyle only the elements that hold what the `:has()` compound requires and that are above or before the one that changed, and a sheet with no `:has()` marks nothing extra. `:has()` is not forgiving, does not nest, and takes no pointer or focus state (`:has(:hover)` is invalid; `hasHover` is the style key for that).

**HTML tags**

- List markers. `li` is `display: list-item` and has a marker: a bullet (`disc`, `circle`, `square`, drawn as shapes sized by the font's ascent as Chrome draws them) or a number (`decimal`, `lower-alpha`, `upper-alpha`, `lower-roman`, `upper-roman`, with Chrome's counter text `1. `). `list-style-type`, `list-style-position` and the `list-style` shorthand are inherited properties; an `outside` marker ends at the item's border box on its first line and takes no part in layout, an `inside` one takes room at the start of the first line. The number is the item's place among the list items of its parent, from `start`, down with `reversed`, and set by an item's `value`; `ol start`, `ol reversed` and `li value` reach native from React and Solid (`forwardsCustomProp`), and the DOM properties `li.value`, `ol.start` and `ol.reversed` reflect them as in the DOM (Lexical assigns `li.value`). Inserting, removing or moving an item, or changing one of those or the type, renumbers the items after it in a retained frame. A `ul`, `ol` or `dl` inside a list has no block margin and a `ul` is a `circle` inside one list and a `square` inside two, as in Chrome. An `outside` marker is the item's for the pointer (`elementFromPoint`, clicks, `:hover`), an `inside` one follows `text-align` and re-measures its text when the number gets wider, the counter's digits are tabular as in Chrome's `::marker`, and `list-style` works in `:hover` and `hover` styles. Painted against headless Chrome's ink at scale 1 and 2 (`list-markers` oracle, React and Solid), and Lexical's list commands now show their bullets and numbers. Not supported: `::marker` styling, `list-style-image`, `counter-*`, `@counter-style`; the counter's scope is the parent element (`docs/fork/deviations.md`).

**Text and fonts**

- `font-family` is a list, as in CSS: the first installed family draws, the installed ones after it are the fallbacks for the glyphs it lacks, and `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `sans-serif`, `serif`, `monospace`, `cursive`, `fantasy` and `math` map to what Chrome uses on macOS. A web font stack no longer falls through to GPUI's fallback face. `<code>` takes the list too.
- Chrome's monospace font-size rule: an element whose `font-family` becomes the generic `monospace` alone has its `font-size` scaled by 13/16 when that size is not an absolute length, and scaled back where the family stops being `monospace`.

**SVG**

- An `<svg>` child takes the kebab-case attribute names the DOM and Solid write (`stroke-width`, `stroke-linecap`, `fill-rule`) as well as React's camelCase props, and a transition or `@keyframes` on one reads the kebab-case attribute as it reads React's prop.

### Fixes

- A scroll no longer freezes while frames take longer than a vsync. The macOS pump ran display-link frame steps back to back in one tick for as long as the link had another one queued, so wheel events were not read and JS did not run for 0.1 to 2 s at a time, and the page kept presenting a frozen scroll. A tick now runs at most one frame step, and the next tick reads the events first.
- Each key event from the keyboard gets its own microtask checkpoint on both sides: `tick()` ends its pump before a `keydown`, `keyup` or modifier change when an event or a frame step came first, and after sending it, and the frame loop ticks again at once, so an editor that commits its update in a microtask (Lexical) applies every key that was waiting, where it used to keep the first and lose the rest. With `frameMs` set the timer path ticks again on the next turn of the event loop (`keyEventPending()`) instead of waiting out the frame. There is still no checkpoint between the listeners of one event or between a key's `keydown` and its `input`, and mouse events handled in one pump share one. The test renderer gets `postNativeKeys`, `pumpNativeEvents`, `setYieldAfterKeyEvent` and `keyEventPending` to drive that pump.
- The live automation client presses a `keystrokes` sequence one key at a time with a turn of the event loop after each, so an editor that commits its update in a microtask (Lexical) takes every key of "m i d" and not only the first. A synchronous `simulateKeystrokes` on the test renderer still runs a sequence inside one call; the limit is in `docs/fork/deviations.md`.
- The text editor's events (`input`, `compositionstart`, `compositionupdate`, `compositionend` and the number stepper's `change`) reach JS synchronously on macOS, in the test renderer and in the web (wasm) renderer, as `keydown` does: after the edit and before the key's `keyup`, in order, in the same tick as the key. A controlled input's echo is drawn by the frame of the key that typed it, where it waited for the next tick before. They are still queued on Windows and Linux.
- A block whose only content is a line break (`<div><br></div>`, `<p><br></p>`, or a lone `"\n"` under `white-space: pre`) is one line tall, as in Chrome, and not zero. `a<br>` stays one line and `<br><br>` is two.
- `xlink:href` and `xlinkHref` on an SVG `<use>` are written as `href`, and the `marker` shorthand no longer writes a marker twice beside a longhand.
- `TestRenderer.dispose()` closes the window itself, while its app is alive, and no longer leaves that to a block on the main queue. A block still queued when the app was released ran in the next renderer's `dispose()` and aborted the process with "app was released before async operation completed". `RowOracle.dispose()`, and a `RowOracle` that a newer one replaces, close their window the same way.

  Two test-only methods: `TestRenderer.disposeLeavingMainQueueForTest()` (`dispose` without running the main queue, so the close block stays queued) and `runMainQueueToMarkerForTest()` (runs the main run loop until a block queued now on the main dispatch queue has run, so every block queued before it has; throws after 5 seconds).

### Dependencies

- Updated dependencies [efdc58a]
- Updated dependencies [32cb7c2]
- Updated dependencies [dbd63d6]
- Updated dependencies [698580c]
- Updated dependencies [5493465]
- Updated dependencies [08786e0]
- Updated dependencies [1ab5788]
- Updated dependencies [c8a846d]
- Updated dependencies [76853dd]
- Updated dependencies [5340a15]
- Updated dependencies [40e4657]
- Updated dependencies [d5d8a2c]
- Updated dependencies [3ecd502]
- Updated dependencies [f610c70]
- Updated dependencies [c126e2d]
- Updated dependencies [a6a5504]
- Updated dependencies [d402189]
- Updated dependencies [bb0bcaf]
- Updated dependencies [7b8e480]
- Updated dependencies [2e41294]
- Updated dependencies [f926534]
- Updated dependencies [b3097eb]
- Updated dependencies [88ba15f]
- Updated dependencies [b0e1a44]
- Updated dependencies [08ab88f]
- Updated dependencies [4a289c4]
- Updated dependencies [7080a6a]
- Updated dependencies [a0347c3]
- Updated dependencies [7f27601]
- Updated dependencies [ed5fd5a]
- Updated dependencies [c8a846d]
- Updated dependencies [fe19c6a]
- Updated dependencies [7c06a8a]
- Updated dependencies [11ad59a]
- Updated dependencies [8d56654]
- Updated dependencies [3fce838]
- Updated dependencies [97d4d8e]
- Updated dependencies [fcc869d]
- Updated dependencies [f807bac]
- Updated dependencies [ad6380d]
- Updated dependencies [8fdb2e6]
- Updated dependencies [866fd8c]
- Updated dependencies [ed8e9ad]
- Updated dependencies [75882f5]
  - @ghia/native@0.14.0
  - ghia@0.14.0

## 0.13.0

The tree is now a DOM. Every window root is `<html>` with `<head>` and `<body>`, nodes are real `Node`, `Element` and `Text` objects, CSS stylesheets and HTML tags work, and code that is not the framework can build, query, style and observe the tree as it does in a browser. As a result these run unmodified: `@base-ui/react` (Checkbox, Switch, Radio, Slider, Field, Popover, Menu, Select), Kobalte and the Base UI Solid ports, the `@dnd-kit/dom` sortable (`@dnd-kit/solid` and `@dnd-kit/react` 0.5.3), floating-ui and TanStack Virtual.

### Breaking changes

- **`<text>` is only an SVG element now.** A string is a DOM text node and goes directly into any element (`<div>Saved</div>`, or strings and `<span>`s as one inline paragraph). `<text>` outside an `<svg>` throws `<text> is only valid inside <svg>`. To migrate, turn a `<text>` that sat inside other text or a `<span>` into a `<span>`, any other `<text>` into a `<div>`, or put the string straight into its parent. `findByType("text")` and tests that read a string node's type now use `"#text"`.
- **`id` is the DOM `id`.** On a host element, `id` is the `id` prop as a string (`""` without one). The number native knows an element by is now `nativeId`, on host elements and text nodes of both adapters. Migrate `renderer.scrollToItem(ref.id, i)` to `renderer.scrollToItem(ref.nativeId, i)`; `FocusableNode` and `ObservableElement` take `nativeId` as well.
- **A text control's `change` fires on commit (Solid and native).** `onChange` and `addEventListener('change')` on an `<input>` or `<textarea>` fire when the user commits a changed value (blur, or Enter in an `<input>`), as in the DOM, instead of on every edit. Move per-keystroke handlers to `onInput` (`HostInputEvent`); `onChange` now receives a `HostChangeEvent`, a plain `Event` rather than an `InputEvent`. Solid's `ComboboxInput` reports through `onInput`. React apps need no change: `onChange` still fires per edit as React DOM's does, and `addEventListener('change')` on a ref gives the commit. For renderer code, `getTextSelection` no longer carries the text; read it with `getTextValue`.
- **Top-level nodes live in `<body>`.** A window root is `<html>` > `<head>` + `<body>`, and the app's top-level nodes are children of `body`, so several top-level siblings all draw (only the last one did). Event paths end at `html`. `<html>` and `<body>` are `display: block`, fill the window and have no default margin.
- **`document.activeElement` is `document.body` when nothing is focused**, where it was `null`, and a key pressed with nothing focused targets `body` and bubbles through `html`, `document` and `window`, where it went to `window` alone with `target === null`. Replace `document.activeElement === null` with `=== document.body`, and a `window` key listener's `event.target === null` check with `=== document.body`.
- **`querySelectorAll` returns a static `NodeList`**, not an `Array` subclass, so it has no `map` or `filter`, as in a browser. Wrap it in `Array.from(...)`. `children` and `childNodes` stay arrays.
- **Host node fields renamed.** A Solid host node's child list is `childList`, because `children` is now the DOM's elements-only list, and a host node's `tag` field is `elementType`.
- **Host element types follow React DOM and solid-js**, which can fail a build that passed: React's `JSX.IntrinsicElements[tag]` props carry the tag's DOM `ref` (`useRef<HTMLDivElement>` on a `div`), which Ghia's own components (still `Ref<PublicInstance>`) do not accept; a callback ref typed narrower than the tag's instance no longer fits; under `moduleResolution: "nodenext"` JSX props are now type-checked where they were `any`; and in Solid a `<li>` callback ref's `value` is `never`.
- **Text selection only on text-like inputs.** `selectionStart`, `selectionEnd` and `selectionDirection` are `null`, and `setSelectionRange()` throws `InvalidStateError`, on every `<input>` type except `text`, `search`, `url`, `tel` and `password`, as HTML says. `email`, `number` and `date` used to have a selection; `select()` still selects their text.
- **For custom adapters and renderer code.** `className` is no longer a native element prop; it is the `class` attribute, sent with the other attributes. Adapters implement the new `ParentBinding`, `TextBinding` and `ElementBinding` members on their `DOM_BINDING`, register a `DomNodeFactory` with `installElementSource`, and join `unmountAllRoots()` through `registerRoot()`. `appliedBatchCount` moved from `@ghia/native/host` to `@ghia/native/testing`.

### Features

**Stylesheets**

- `<style>` elements and constructed sheets (`new CSSStyleSheet()` in `document.adoptedStyleSheets`, with `replace`, `insertRule`, `deleteRule` and `cssRules`) style the tree. Type, class, id and attribute selectors, `:is()`, `:where()`, `:not()`, `:root`, the four combinators, nesting and `@layer` match, and `!important` is honoured against the `style` prop. `@media`, `@keyframes`, pseudo-elements and the other at-rules are skipped; see `docs/fork/deviations.md`.
- Stylesheets read `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` and `:popover-open`, and a new inline `focus` style block applies while the element has focus. Focus styles transition and pass inherited values (`color`, `fontSize`) to children.
- `initial`, `unset`, `inherit` and `revert` take back user agent and base styles as in CSS, in sheets, inline styles and state blocks.

**HTML tags and form controls**

- HTML tags are host elements with Chrome's default style and implicit accessibility roles: `<p>`, `<h1>` to `<h6>`, lists, `<section>`, `<nav>`, `<main>`, `<table>` and its parts, `<strong>`, `<em>`, `<a>`, `<br>`, `<button>` and the rest listed in `docs/reference.md`. Inline tags join their parent's paragraph like a `<span>`. `<button>` and `<a href>` are tab stops, Enter and Space click a focused button, and a button submits its form (`event.submitter`, `form.requestSubmit(submitter)`).
- `<input type="checkbox">`, `"radio"`, `"hidden"` and `"range"` work as in HTML: toggling and radio groups, `input` then `change`, `checked`, `defaultChecked`, `indeterminate`, `valueAsNumber`, `stepUp()`, keyboard stepping for a range, and `FormData`. They paint nothing themselves, since Base UI draws its own; see the deviations.
- Text controls fire `input` (an `InputEvent` with `inputType` and `data`) once per edit and `change` on commit, at the DOM's times.
- The constraint validation API on `<input>` and `<textarea>`: `required`, `validity` (`valueMissing`, `customError`), `setCustomValidity()`, `checkValidity()` and `reportValidity()`. `ValidityState` is a global.
- `setAttribute('value' | 'checked')`, `defaultValue` and `defaultChecked` behave as the DOM's defaults, and `value`, `checked` and `indeterminate` can be written before the element mounts.

**The DOM from code**

- `Node`, `Element`, `HTMLElement`, `SVGElement`, `Text`, `Document` and the `HTML*Element` classes Base UI checks are real classes, exported by `@ghia/native/host` and installed as globals where the runtime has none.
- Build and move nodes from code beside the framework's: `document.createElement`, `createElementNS`, `createTextNode`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `remove`, `before`, `after`, `append`, `prepend`, `replaceChildren`, `cloneNode` and the `textContent` setters. React and Solid pick up the tree the code left.
- `matches`, `closest`, `querySelector` and `querySelectorAll` take real CSS selectors, compiled once and cached. `getElementsByTagName`, `getElementsByClassName`, `getElementsByName`, `getElementById` and `document.createTreeWalker` are there too.
- `MutationObserver` with the standard's options and delivery. With no observer alive it costs one integer check per change.
- `setAttribute`, `removeAttribute` and `toggleAttribute` write the prop through the framework's own path, so `aria-hidden`, `inert` and `data-*` set by floating-ui or Base UI reach native at once. `classList` and a live `dataset` come with them.
- `element.style` is a `CSSStyleDeclaration` over the live style (`setProperty` with `important`, `getPropertyPriority`, `cssText`, camelCase members), merged with the framework's own style updates.
- Layout reads: `getComputedStyle`, `offsetWidth`/`offsetHeight`, `offsetParent`/`offsetLeft`/`offsetTop`, `clientLeft`/`clientTop`, `getClientRects()`, `document.elementFromPoint` and `elementsFromPoint`.
- Events: delivered events are instances of `PointerEvent`, `MouseEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent` and the other DOM classes (with `getModifierState`), `element.dispatchEvent` and `document.dispatchEvent` run capture, target and bubble (and a dispatched `click` activates labels and submit buttons), and `addEventListener` takes `capture`, `once`, `passive` and `signal`. `onKeyDownCapture`, `onKeyUpCapture`, `onFocusCapture` and `onBlurCapture` (plus `onFocusInCapture` and `onFocusOutCapture` in Solid) used to be dropped silently.
- The popover API: `popover`, `showPopover()`, `hidePopover()`, `togglePopover()`, `beforetoggle` and `toggle`, drawn in the top layer with light dismiss for `popover="auto"`.
- Web Animations: `element.animate(keyframes, options)` returns the same `Animation` that `getAnimations()` lists, and `KeyframeEffect`, `Animation`, `CSSAnimation`, `CSSTransition` and `DocumentTimeline` are globals.
- `window` has `innerWidth`, `innerHeight`, `visualViewport` and a `resize` event; `requestAnimationFrame` runs in the window's frame steps; `ResizeObserver`, `IntersectionObserver` (which takes `document` as its root) and `matchMedia` are globals; `document.getSelection()` and `selectionchange` exist.

**Solid**

- `solid()` compiles Solid component libraries from their JSX source (the `solid` export condition), so Kobalte and the Base UI Solid ports run unmodified. `solid-js/web` resolves to the new `@ghia/solid/web` (`Dynamic`, `Portal`, `render(code, element)`, `spread`, `isServer`, and the server-only API so `@solidjs/router` and `@solidjs/meta` compile).
- JSX written with HTML attribute names works: `autofocus`, `tabindex`, `readonly`, `maxlength`, `colspan`, `rowspan` and `for`.
- `style` takes CSS-named keys (`'white-space'`, `'z-index'`, `-webkit-app-region`) and a CSS text string (`style="color: red"`), as Solid on the web does. A style typed as solid-js's `JSX.CSSProperties` is assignable without a cast.
- `@ghia/solid/tsconfig` is a tsconfig base for apps (`"extends": "@ghia/solid/tsconfig"`), which also fixes TS2875 for `.tsx` libraries under pnpm.
- Host props accept what solid-js types for the same attribute, so `JSX.HTMLAttributes` spreads onto a host element.

**React**

- Host elements take `className` and `<style>` is a JSX element. Refs are typed by the tag's DOM interface, so TanStack Virtual's `measureElement` needs no cast; `HostRef`, `TextControlInstance` and `FormInstance` are exported.
- Suspense and Activity hide a child through its live `style` as React DOM does.

### Fixes

- `element.animate()` keeps running after the element is removed, and `getKeyframes()` of a retargeted transition no longer throws.
- A throw while flushing no longer stops later flushes. Solid's `render()`, `flush()`, `flushSync()`, `dispatch()` and `unmount()` and React's `unmount()` finish their work and then rethrow (one error, or an `AggregateError`), a Solid root without `onUncaughtError` logs errors with `console.error`, and a throwing `onCleanup` no longer leaves a Solid root unable to render.
- A Solid component that renders a non-node value (solid-refresh's placeholder after a caught throw) renders nothing and warns once, where it froze the window.
- A prop that leaves a Solid spread is removed, and children that change through a spread replace the old nodes instead of being appended.
- `element.focus()` does nothing on an element that is not rendered (`display: none`, `visibility: hidden`, `inert`), as in a browser.
- An element used after its window closed, or after a test renderer was disposed, behaves as a detached node instead of throwing or reaching another window. Handlers that moved focus to each other in a loop throw `Maximum call stack size exceeded` instead of aborting the process.
- `document.documentElement`, `head` and `body` are never `null`; what code writes to them before the first `render()` carries over to the real root.
- A full reload under `ghia dev` unmounts the roots before running the entry again, as a page reload does.
- `<label for>` names its control in React, and in Solid on every element.
- `draggable` reflects as `"true"` or `"false"`, as the DOM does.
- `selectionStart` and friends on a checkbox, radio, range or hidden input are `null` instead of throwing.

## 0.12.1

### Breaking changes

- **`applyBatch` takes the bytes of the mutation batch, not a JSON string.** This breaks anything that calls `applyBatch` itself on the live, test or wasm renderer; tests that built or parsed a batch use `encodeWireBatchForTest` and `decodeWireBatchForTest` from `@ghia/native/testing`. `MutationRenderer.setStyle` takes the style's JSON text as an optional third argument, which Solid passes from the text its write comparison already made, so a written style is stringified once.

### Performance

- The mutation batch is one binary byte array instead of JSON text. `createMutationQueue` writes each op as it is enqueued through `WireWriter` (internal to `@ghia/native`, `js/wire.ts`; not exported) into reused buffers, with no tuple per op and no `JSON.stringify` of the batch, and `applyBatch(bytes: Uint8Array)` on the live, test and wasm renderers decodes it in place (`batch::wire`), so the napi call transcodes no string and the decoder allocates nothing per op beyond what it keeps. The format is specified in `docs/reference.md` ("Wire format"). A failed batch is put back in front of what was enqueued since, and a style native rejects is cut out of the batch by its byte range, as before.

### Dependencies

- Updated dependencies [9100adc]
- Updated dependencies [9100adc]
- Updated dependencies [a1ba92a]
- Updated dependencies [57bab8d]
- Updated dependencies [5bf8afb]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [4a139f0]
- Updated dependencies [381e84f]
- Updated dependencies [a5db856]
- Updated dependencies [6c9f646]
- Updated dependencies [a424e75]
- Updated dependencies [3b381be]
- Updated dependencies [14d6582]
- Updated dependencies [6719139]
- Updated dependencies [a0cfc02]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [9282468]
- Updated dependencies [14d6582]
- Updated dependencies [e1c7649]
- Updated dependencies [5a6650c]
- Updated dependencies [14d6582]
- Updated dependencies [14d6582]
- Updated dependencies [afade40]
  - @ghia/native@0.12.1
  - ghia@0.12.1

## 0.12.0

### Breaking changes

- **The Bun preload and `@ghia/solid/bun-plugin` are removed, along with the compile cache and the Babel dependencies they used:** run Solid apps with `ghia dev` and `ghia build` from `ghia`. Apps need `@ghia/native` as a direct dependency.

### Features

- `solid()` from `@ghia/solid/vite` compiles JSX for the universal renderer (`moduleName: "@ghia/solid"`) with Solid HMR in `ghia dev`, so an edited component updates without a reload, and it also compiles under vitest.
- `solid({ include, exclude })` compiles only the files it names, for an app that also uses `react()` from `@ghia/react/vite`.
- `@ghia/solid` re-exports `isWebBuild`.

### Performance

- Solid no longer queues a `setStyle` or `setCustomProp` for a value the element already has. An effect that ran again and built an equal style object (a row whose style reads `selected`, an `aria-label` and a style in one effect) sent the whole style to native every time: in the bench's mailbox app, 180 identical `setStyle` ops and 27 KB of JSON for a key that changed nothing. The host remembers the JSON it last wrote for each element's style and custom props and writes only what differs from it, so a style object changed in place and passed again is still written, and so is a key order that differs. A prop never written is written, and a new native element starts with nothing written. `@ghia/native/host` exports `SentWrites`.

### Fixes

- In `ghia dev`, a full reload no longer logs `You appear to have multiple instances of Solid`: `solid()` resets the flag at the start of each run, and a real second copy of `solid-js` inside one run still warns.
- `render()` reports native errors to the `onUncaughtError` of its latest call instead of the first one's.
- A node Solid removes is out of the native tree at once, as `removeChild` takes it out of the document, and a layout read in the same turn no longer lays out the removed subtree. The host used to detach it on the JS side and tell native only at the flush, so `getBoundingClientRect` or `scrollHeight` right after a keyed `<Show>` swap built and laid out the old subtree beside the new one (the mailbox navigate proxy: a detail scroller with twice its children in the pass, 56 elements built there for 40 now). `removeHostNode` now queues a new `detachChild` op, which takes the element out of its parent and keeps it, with its state, for an insertion that puts it back; the element is still destroyed at the flush if it stayed out.

### Dependencies

- Updated dependencies [8fcd806]
- Updated dependencies [7528529]
- Updated dependencies [8fe6300]
- Updated dependencies [9be6797]
- Updated dependencies [c936c56]
- Updated dependencies [d711914]
- Updated dependencies [521b773]
- Updated dependencies [9d68f3b]
- Updated dependencies [3a1421b]
- Updated dependencies [c4b1800]
- Updated dependencies [0a746f2]
- Updated dependencies [4ee7fa6]
- Updated dependencies [57e782f]
- Updated dependencies [c4e29c2]
- Updated dependencies [4c7d9c6]
- Updated dependencies [d246bac]
- Updated dependencies [7419c3b]
- Updated dependencies [134e72b]
- Updated dependencies [5a6ecc0]
- Updated dependencies [fe4feb4]
- Updated dependencies [05929b1]
- Updated dependencies [4944439]
- Updated dependencies [c0e1eb7]
- Updated dependencies [1ed2c72]
- Updated dependencies [fcc0d2e]
- Updated dependencies [cef50f9]
- Updated dependencies [b871632]
- Updated dependencies [c6a6271]
- Updated dependencies [4e79714]
- Updated dependencies [69e9c2b]
- Updated dependencies [671330d]
- Updated dependencies [3ed3d47]
- Updated dependencies [c642e6a]
- Updated dependencies [523e8dd]
- Updated dependencies [bd73d27]
- Updated dependencies [a0b62db]
- Updated dependencies [a198da5]
- Updated dependencies [863db25]
- Updated dependencies [ec13354]
- Updated dependencies [439271f]
- Updated dependencies [9bce77d]
- Updated dependencies [f6b9458]
- Updated dependencies [77be0bf]
- Updated dependencies [4b90976]
- Updated dependencies [c668d7f]
- Updated dependencies [8d9a70f]
- Updated dependencies [dec3bf7]
- Updated dependencies [a0d537f]
  - @ghia/native@0.12.0
  - ghia@0.12.0

## 0.11.1

### Features

- A window opened with `GPUIX_BACKGROUND=1` in the environment emulates focus, as Chrome does with CDP's `Emulation.setFocusEmulationEnabled`: it behaves as active for `onFocus`, `onBlur`, `:focus-visible`, the caret and `focusElement`, without becoming the key window or activating the app. Until now a window opened behind other apps (`focus: false`) fired no focus event and drew no caret while typed text still arrived. A window without the variable is unchanged: a window that is not active fires no focus events, as in Chrome, and they fire once it is activated. The library reads the variable once, when the window opens; apps that map it to `focus: false` keep doing that.
- `kind: 'panel'` in the window options opens the window as a non-activating panel: a normal window (titlebar, resizing, buttons, appearance, background, normal window level) that can be the key window without activating the app. With `focus: true` it is key while the frontmost app stays frontmost, so a capture can show the key look (glass tints, accent colours, traffic lights) that a `focus: false` window never has. `renderer.isWindowKey()` reads whether AppKit reports the window as key. An unknown `kind` throws; `'normal'` is the default, and on Windows and Linux a panel is a normal window. A panel takes the keyboard like any key window, so open one only for a capture and close it right after.

### Fixes

- `dragBy`, `dragTo` and `mouse.drag` drive a drag on a live window when the app drives its own renderer in-process (`connectTest(liveRendererAsTest(renderer))`). The live renderer delivers a press and a release to the page at once but a move only on a later turn of the event loop, so a drag stepped in one synchronous burst reached the page as press, release, then the moves, and a handle that ends its drag on `pointerup` never moved. `liveRendererAsTest` now waits one event-loop turn after every input it simulates, and `TestAutomationRenderer`'s input methods may return a promise.

### Dependencies

- Updated dependencies [52fd03d]
- Updated dependencies [a2d57e7]
- Updated dependencies [d70feb5]
- Updated dependencies [05f72cd]
- Updated dependencies [7da4cea]
- Updated dependencies [bb3412f]
- Updated dependencies [6a78fe8]
- Updated dependencies [a6de850]
- Updated dependencies [ff5975c]
  - @ghia/native@0.11.1

## 0.11.0

First Ghia release, forked from gpuix 0.10.0. See docs/fork/index.md for what changed.

### Dependencies

- Updated dependencies [c4437f3]
  - @ghia/native@0.11.0
