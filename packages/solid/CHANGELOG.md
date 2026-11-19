# @ghia/solid

## 0.14.0

### Minor Changes

- 698580c: ### Breaking changes
  
  - **`<code code=... language=...>` is now `<code-block ...>`, and `<code>` is HTML's inline element.** The syntax-highlighted block keeps its props (`code`, `language`, `path`, `showLineNumbers`, `theme`) under the new name, so rename the tag (`<code-block code={source} language="ts" />`), the JSX type `CodeProps` to `CodeBlockProps`, and `findByType("code")` to `findByType("code-block")`. A `<code>` now lays out as `<span>` with the user agent style of Chrome's `code`: the generic `monospace` family, drawn at 13px beside 16px text by Chrome's monospace size rule (see `docs/reference.md`, "Monospace size"), so code that renders text inline in a paragraph (Lexical's Code format) works unchanged.
  - **`pre`, `kbd` and `samp` use the generic `monospace` at Chrome's size**, not `Menlo` at the inherited size: they are 13px where the text around them is 16px, unless an absolute `font-size` is inherited or the `font-family` is a longer list (`monospace, monospace`). `tt` is a tag too.
  
  ### Features
  
  - Chrome's monospace font-size rule: an element whose `font-family` becomes the generic `monospace` alone has its `font-size` scaled by 13/16 when that size is not an absolute length, and scaled back where the family stops being `monospace`.

### Patch Changes

- 5340a15: `Range`, `StaticRange` and `AbstractRange` exist, with `document.createRange()`. A `Range` is live: a tree change, including a React or Solid insert, removal or text update, and a data change move its boundary points as the DOM standard says. `CharacterData` has `substringData`, `appendData`, `insertData`, `deleteData` and `replaceData`, `Text` has `splitText` and `wholeText`, and `document.hasFocus()` answers.
- 3ecd502: `Range.getClientRects()` and `getBoundingClientRect()` are the rects of the selected text, one for each painted line of each Text node and the border box of each element the range selects whole, and a collapsed range in text is the caret rect. `document.caretPositionFromPoint(x, y)` (with the `CaretPosition` global) and `document.caretRangeFromPoint(x, y)` give the text position nearest a point. `Selection.modify` takes the `line`, `lineboundary` and `documentboundary` granularities: moves by line keep the caret's x across a short line. Native has three new reads for them (`getTextRangeRects`, `caretPositionFromPoint`, `moveCaretVisually`).
- c8a846d: `getSelection()` holds a live `Range` of nodes once code selects them: `anchorNode`, `focusNode`, `direction`, `getRangeAt`, `addRange`, `removeRange`, `collapse`, `extend`, `setBaseAndExtent`, `selectAllChildren`, `containsNode`, `deleteFromDocument`, `getComposedRanges` and `modify` by character and word, with the DOMExceptions of the standard. A node selection and the painted text a drag selects replace each other. `document` hears one coalesced `selectionchange` per burst of changes, including a move caused by a tree or data change. `focus()` on an editing host puts a caret at its start.
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

### Patch Changes

- 9100adc: The mutation batch is one binary byte array instead of JSON text. `createMutationQueue` writes each op as it is enqueued through `WireWriter` (internal to `@ghia/native`, `js/wire.ts`; not exported) into reused buffers, with no tuple per op and no `JSON.stringify` of the batch, and `applyBatch(bytes: Uint8Array)` on the live, test and wasm renderers decodes it in place (`batch::wire`), so the napi call transcodes no string and the decoder allocates nothing per op beyond what it keeps. The format is specified in `docs/reference.md` ("Wire format"). **Breaking for anything that calls `applyBatch` itself**: it takes the bytes, not a JSON string; tests that built or parsed a batch use `encodeWireBatchForTest` and `decodeWireBatchForTest` from `@ghia/native/testing`. `MutationRenderer.setStyle` takes the style's JSON text as an optional third argument, which Solid passes from the text its write comparison already made, so a written style is stringified once. A failed batch is put back in front of what was enqueued since, and a style native rejects is cut out of the batch by its byte range, as before.
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

### Minor Changes

- 9d68f3b: `solid({ include, exclude })` compiles only the files it names, for an app that also uses `react()` from `@ghia/react/vite`.
- 4c7d9c6: The Bun preload and `@ghia/solid/bun-plugin` are removed, along with the compile cache and the Babel dependencies they used: run Solid apps with `ghia dev` and `ghia build` from `ghia`. `solid()` from `@ghia/solid/vite` compiles JSX for the universal renderer (`moduleName: "@ghia/solid"`) with Solid HMR in `ghia dev`, so an edited component updates without a reload, and it also compiles under vitest. `@ghia/solid` re-exports `isWebBuild`. Apps need `@ghia/native` as a direct dependency. In `ghia dev`, a full reload no longer logs `You appear to have multiple instances of Solid`: `solid()` resets the flag at the start of each run, and a real second copy of `solid-js` inside one run still warns. `render()` reports native errors to the `onUncaughtError` of its latest call instead of the first one's.

### Patch Changes

- 9bce77d: A node Solid removes is out of the native tree at once, as `removeChild` takes it out of the document, and a layout read in the same turn no longer lays out the removed subtree. The host used to detach it on the JS side and tell native only at the flush, so `getBoundingClientRect` or `scrollHeight` right after a keyed `<Show>` swap built and laid out the old subtree beside the new one (the mailbox navigate proxy: a detail scroller with twice its children in the pass, 56 elements built there for 40 now). `removeHostNode` now queues a new `detachChild` op, which takes the element out of its parent and keeps it, with its state, for an insertion that puts it back; the element is still destroyed at the flush if it stayed out.
- f6b9458: Solid no longer queues a `setStyle` or `setCustomProp` for a value the element already has. An effect that ran again and built an equal style object (a row whose style reads `selected`, an `aria-label` and a style in one effect) sent the whole style to native every time: in the bench's mailbox app, 180 identical `setStyle` ops and 27 KB of JSON for a key that changed nothing. The host remembers the JSON it last wrote for each element's style and custom props and writes only what differs from it, so a style object changed in place and passed again is still written, and so is a key order that differs. A prop never written is written, and a new native element starts with nothing written. `@ghia/native/host` exports `SentWrites`.
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

### Patch Changes

- a2d57e7: A window opened with `GPUIX_BACKGROUND=1` in the environment emulates focus, as Chrome does with CDP's `Emulation.setFocusEmulationEnabled`: it behaves as active for `onFocus`, `onBlur`, `:focus-visible`, the caret and `focusElement`, without becoming the key window or activating the app. Until now a window opened behind other apps (`focus: false`) fired no focus event and drew no caret while typed text still arrived. A window without the variable is unchanged: a window that is not active fires no focus events, as in Chrome, and they fire once it is activated. The library reads the variable once, when the window opens; apps that map it to `focus: false` keep doing that.
- 05f72cd: `dragBy`, `dragTo` and `mouse.drag` drive a drag on a live window when the app drives its own renderer in-process (`connectTest(liveRendererAsTest(renderer))`). The live renderer delivers a press and a release to the page at once but a move only on a later turn of the event loop, so a drag stepped in one synchronous burst reached the page as press, release, then the moves, and a handle that ends its drag on `pointerup` never moved. `liveRendererAsTest` now waits one event-loop turn after every input it simulates, and `TestAutomationRenderer`'s input methods may return a promise.
- 6a78fe8: `kind: 'panel'` in the window options opens the window as a non-activating panel: a normal window (titlebar, resizing, buttons, appearance, background, normal window level) that can be the key window without activating the app. With `focus: true` it is key while the frontmost app stays frontmost, so a capture can show the key look (glass tints, accent colours, traffic lights) that a `focus: false` window never has. `renderer.isWindowKey()` reads whether AppKit reports the window as key. An unknown `kind` throws; `'normal'` is the default, and on Windows and Linux a panel is a normal window. A panel takes the keyboard like any key window, so open one only for a capture and close it right after.
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

### Minor Changes

- c4437f3: First Ghia release, forked from gpuix 0.10.0. See docs/fork/index.md for what changed.

### Patch Changes

- Updated dependencies [c4437f3]
  - @ghia/native@0.11.0
