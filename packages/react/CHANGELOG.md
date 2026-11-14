# @ghia/react

## 0.13.0

### Minor Changes

- 9ee7f29: Every window root is a real `<html>` with a `<body>` in it, and the app's top-level nodes are children of `body`, so several top-level siblings all draw (native drew only the last one). `document.documentElement`, `document.body` and `document.scrollingElement` give them for the window that mounted last (`null` with nothing mounted); `html.parentNode` is `document` and a top-level element's `parentNode` is `body`. `document.body` is a portal container (`createPortal(children, document.body)`), a pointer-capture target and a member of event paths, which now end at `html`. Both are `display: block` and fill the window, with no default margin; see the deviation in `docs/fork/deviations.md`.
- 108927a: Every window root is `<html>` > `<head>` + `<body>`: `document.head` is a real `display: none` element before `body` (no box, children never drawn), so `documentElement.children` is `[head, body]` and a library can prepend a node to it. `window` gets `innerWidth` and `innerHeight` (the window's content size in CSS pixels, live), `visualViewport` (`width`, `height`, `offsetLeft`, `offsetTop`, `pageLeft`, `pageTop`, `scale`, and a `resize` event on `addEventListener`), `frameElement`, and `parent`, `top` and `self` where the runtime has none. `getComputedStyle`, `matchMedia` and `IntersectionObserver` are globals unless the runtime has its own.
- f2bef8f: `window` gets a `resize` event, sent with `visualViewport`'s when the window's size changes, from one subscription. `document.elementFromPoint(x, y)` and `elementsFromPoint(x, y)` (forced reads over `getElementsAt`, topmost first, ending with `body` and `html`), and `document.getSelection()` / `window.getSelection()` with a global `Selection` (`rangeCount`, `isCollapsed`, `type`, `toString()`, `removeAllRanges()`, `empty()`), plus a `selectionchange` event on `document` that a listener turns on in native. Events have `nativeEvent` (the event itself) and pointer events `isPrimary` (`true`).
- 3452f68: `element.dispatchEvent(event)` and `document.dispatchEvent(event)`: any runtime `Event` (`new Event`, `new CustomEvent`, the new `PointerEvent` and the other event classes) walks capture, target and bubble through the element's ancestors, and `window` and `document` around them, and is heard by `on*` props, Solid handlers and `addEventListener` listeners with `isTrusted` false. It returns `!event.defaultPrevented`, throws an `InvalidStateError` for an event already being dispatched, and a dispatched `focusin` reaches React's `onFocus`. An uncanceled `click` that is a `MouseEvent` then runs the element's activation behaviour: a label focuses its control and a submit button submits its form (native `activateElement`). Checkbox and radio toggling is a later slice. So Base UI's `new (ownerWindow(el).PointerEvent)('click', { ...modifiers })` and `el.dispatchEvent(event)` work. A rejected dispatch (an event already being dispatched) happens before the click's pre-activation, so it toggles no checkbox.
- 18c692c: The events Ghia delivers are instances of the DOM's event classes: `click` and the pointer types are `PointerEvent`, the other mouse types `MouseEvent`, `wheel` `WheelEvent`, the drag types `DragEvent`, `keydown`/`keyup` `KeyboardEvent`, the focus types `FocusEvent`, `onChange`'s event an `InputEvent`, and the composition, transition and animation types their classes, all `instanceof Event` and `isTrusted` `true`. The classes (`UIEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `DragEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `CompositionEvent`, `TransitionEvent`, `AnimationEvent`) are exported by `@ghia/native/host` and installed as globals where the runtime has none, with the DOM's constructor init dictionaries and defaults, so `new (element.ownerDocument.defaultView.PointerEvent)('click', { shiftKey: true })` works. `getModifierState('Shift' | 'Control' | 'Alt' | 'Meta')` is on mouse, pointer, wheel, drag and keyboard events, and every mouse event has `shiftKey`, `ctrlKey`, `altKey` and `metaKey`. A delivered event is built without the runtime's `Event` constructor, so its inherited native methods such as `initEvent` throw and it cannot be passed to a runtime `EventTarget`'s `dispatchEvent`; see `docs/fork/deviations.md`.
- 947501e: DOM members a library such as `@dnd-kit/dom` reads. `matches`, `closest` and `querySelector` take `:popover-open`, and answer for elements `document.createElement` made before they are inserted. `setAttribute('popover', ...)` and `removeAttribute('popover')` hide a showing popover whose kind they change, as the `popover` property does. `element.style` keeps a property a browser has and Ghia has no style key for (`touch-action`, `will-change`, `scroll-snap-type`, from `mdn-data`'s property list): it reads back from `getPropertyValue`, the accessor, `cssText` and `getAttribute('style')`, and is never sent to native; a name that is no CSS property (`foo-bar`) is ignored. The `style` attribute reads `""` once code has written the style and emptied it, and `null` only before that or after `removeAttribute('style')`. New: `document.compatMode` (`"CSS1Compat"`) and the reflected `disabled` (button, input, select, textarea, fieldset, optgroup, option) and `htmlFor` (label) members.
- 1d7829a: `matches`, `closest`, `querySelector` and `querySelectorAll` take real CSS selectors, on elements, `document` and `DocumentFragment` (tag, class, id, attributes, the combinators, `:not`, `:is`, `:has`, `:scope`, `:disabled` and more; `:focus`, `:focus-visible`, `:focus-within`, `:hover` and `:active` ask the window). An invalid selector throws a `SyntaxError`. `matches` used to throw for anything but the five state selectors, so libraries that call these (Base UI's focus trap, floating-ui) run unchanged. Selectors are compiled once and cached; see `docs/fork/deviations.md` for what differs from Chrome.
- ec44f9b: `setAttribute`, `removeAttribute` and `toggleAttribute` on every element write the prop the attribute stands for, through the framework's own prop path, so a library written for the DOM has its effect: `aria-hidden`, `inert`, `tabindex` and `data-*` set by Floating UI's `markOthers` or Base UI's focus manager reach native at once, and `getAttribute`, `getAttributeNames`, `dataset` and `MutationObserver` records see them. A later React or Solid commit of the same prop overwrites the attribute, as in the DOM. `style` and `on*` are kept as text for `getAttribute` and do nothing else (see deviations). On an `<input>`, `setAttribute('checked')` writes `defaultChecked` and `setAttribute('value')` writes `defaultValue` (the control follows them only while it is clean), as in the DOM; the `value` attribute of a checkbox, radio, hidden, submit, button, reset or image input is its value itself. A text input or textarea given a `defaultValue` shows it until it is given a `value` or the user edits it. `input.defaultChecked = x` is `setAttribute('checked', '')` (or `removeAttribute`), so `getAttribute`, `[checked]` selectors and a `MutationObserver` see it, and `input.defaultValue` and `textarea.defaultValue` read and write the `value` attribute and the default text. One rule picks the prop that answers an input's `checked` and `value` attributes for `getAttribute` and for native's attribute store: the default, else the `checked` or `value` prop. A number given as `value` or `defaultValue` is its text, as in React DOM.
- cccd1c5: The last small DOM members that real Base UI and `@floating-ui` read are there, so they run unchanged. An element has `offsetParent`, `offsetLeft`, `offsetTop`, `clientLeft`, `clientTop` and `getClientRects()` (read from the laid-out box, and an empty list or 0 for an element with no box), `hidden` (the attribute, and `display: none` by the user agent style as in Chrome, so an author `display` is over it), `tabIndex` (the attribute, else the tag's default), `isContentEditable` (always `false`), and `shadowRoot` and `assignedSlot` (always `null`). `document.getElementById(id)` and `document.createElement(name)` exist; `createElement` makes an element that is in no tree, for a library to measure or feature-test with (it cannot be inserted). `HTMLInputElement`, `HTMLTextAreaElement`, `DOMRect` and `DOMRectReadOnly` are globals, and `window.scrollX` and `scrollY` are 0. The `hidden` prop now reaches native on every element, and `element.dataset` is a live `DOMStringMap` (an assignment or `delete` writes the `data-*` attribute) instead of a frozen snapshot.
- b08d26b: A string child is a DOM text node, and `<text>` is no longer a host element. The adapters create a string as a node of type `#text` (`createElement(id, "#text")`, then `setText`, which is for `#text` only), and it goes in any element: `<div>Saved</div>`, `<span>Saved</span>`, or a run of strings and `<span>`s as one inline paragraph; in a flex or grid container a run of strings is one anonymous item. **Breaking:** `<text>` outside an `<svg>` throws on placement (`<text> is only valid inside <svg>`), like any other SVG element; inside an `<svg>` it is SVG text, unchanged. Migrate a `<text>` that was inline (inside a `<text>` or a `<span>`) to a `<span>` and any other to a `<div>`, or put the string in the parent; `findByType("text")` and tests that read the type `text` of a string node read `#text`. A host element whose content is one paragraph is now readable by a screen reader: it is a `Label` with the text as its value when it has no role of its own, and any other role (`button`, `heading`, `link`) is named by the text unless the author named it (`aria-label`, `aria-labelledby`, a `<label>`), and in a container with paragraphs beside block children each paragraph is a `Label` node of its own while a screen reader is on, in skipped `content-visibility` content too. An element that holds a string directly is a costly element worth a retained root, as `<text>` was. Documented in `docs/reference.md` ("Inline text", "Accessibility").
- 4abfea9: Breaking: `id` on a host element is now the DOM's `id`, the `id` prop as a string (`""` without one). The number native knows an element by, which the renderer methods take (`renderer.scrollToItem(ref.id, i)`), is renamed `nativeId` on host elements and text nodes of both adapters (`renderer.scrollToItem(ref.nativeId, i)`). `FocusableNode` and `ObservableElement` take `nativeId` too.
- 59be768: `element.style` keeps a property's priority, so a library written for the DOM that sets styles by hand runs unchanged: Base UI's `style.setProperty(name, 'initial', 'important')` and its restore with `getPropertyPriority`. A property written with `important` (`setProperty(name, value, 'important')`, `!important` in `cssText` or in `setAttribute('style', text)`) is held as the value with an `!important` suffix, the form a framework writes one (`display: "none !important"`), so it beats a stylesheet's `!important` rule as in Chrome; every read gives the plain value, `getPropertyPriority` reports it and `cssText` prints `display: none !important;`. A style string that holds a number for a unitless property (`opacity: '0.5'`) is now accepted. React hides a Suspense or Activity child through its live `style` as React DOM does (`setProperty('display', 'none', 'important')`), so the hidden element reads `display: none` with priority `important`, its `style` attribute has it and a `MutationObserver` records it; unhiding sets `display` to the one its props give, else `''`, which drops a `display` that code wrote meanwhile. A hidden text node is emptied, as in React DOM. Code's write of a style is deferred to the flush, and is dropped there when the element is gone or a commit already sent that style.
- 75aa218: HTML tags work: `<p>`, `<h1>` to `<h6>`, `<ul>`, `<ol>`, `<li>`, `<dl>`, `<section>`, `<nav>`, `<main>`, `<article>`, `<figure>`, `<blockquote>`, `<pre>`, `<hr>`, `<table>` and its parts, `<strong>`, `<em>`, `<a>`, `<br>`, `<button>` and the rest of the list in `docs/reference.md` ("HTML tags") are host elements with Chrome's default style (margins, sizes, weights, `display`), so markup written for the web looks and lays out as it does in Chrome. A tag whose default `display` is `inline` joins the paragraph of its parent like a `<span>`, a block tag ends it, and your own `style` or `<UniversalStyle>` wins over the default. The tags have their implicit accessibility roles (`button`, `link` for `<a href>`, `heading` with its level, landmarks, lists, tables), a `<button>` and an `<a href>` are tab stops without a `tabIndex`, Enter and Space click a focused `<button>` (Enter an `<a href>`) and Space on a button no longer scrolls. A `<label>` activates and names a `<button>`. In a form, a click on a `<button>` (`type` `submit`, the default, or `button`; `reset` does nothing) submits it with `event.submitter` set to the button, Enter in an `<input>` clicks the form's first submit button when it has one (a form with a submit button now submits on Enter whatever the number of `<input>`s), and `form.requestSubmit(submitter)` takes a submit `<button>` of the form (a `TypeError` otherwise, a `NotFoundError` when it belongs to another form). The JSX typings of `@ghia/react` and `@ghia/solid` know the tags, with `href` on `<a>` and `type` and `disabled` on `<button>`. Not done, listed in `docs/fork/deviations.md` ("HTML tags"): list markers, `<a>` link styling and navigation, `<dialog open>`, `<fieldset disabled>`, form reset and Chrome's themed button. `<code>` and `<select>` stay Ghia's own elements.
- fb29c70: `<input type="checkbox">`, `<input type="radio">` and `<input type="hidden">` work as in HTML, so the real `@base-ui/react` Checkbox, Switch, Radio and form fields run unchanged. A checkbox and a radio are a 13 by 13 `inline-block` box with Chrome's margin and nothing painted in it, with the role, the toggled state (`mixed` when indeterminate) and a tab stop; a hidden input builds no box, takes no focus and has no accessibility node. A click, Space, `element.click()` and a `click` an app dispatches toggle the control before the click's listeners run, put it back when one cancels the click, and otherwise fire `input` then `change` (bubbling, not cancelable); a radio unchecks its group (same `name`, same form, or the same tree with no form), and a label toggles its control once. `onInput` is a handler prop. `checked`, `defaultChecked` (only while not dirty), `indeterminate` and `value` are properties of an `<input>` element (React and Solid refs), and in React a control with a `checked` prop goes back to it after the `change` handlers, as React DOM restores a controlled input (Solid does not, as on the web). Assigning `checked`, `defaultChecked` or `indeterminate` from code changes the control's own state and no prop, so a click toggles it from there. A checked checkbox or radio is in `FormData` under its `value` (`"on"` by default), a hidden input always is, and neither blocks implicit submission. `:checked` and `:indeterminate` in `matches` and `querySelector` read the live state. Arrow keys do not move between radios, and no check mark or dot is drawn: see `docs/fork/deviations.md`.
- 04d2672: `<input type="range">` works as in HTML, so the real `@base-ui/react` Slider, whose thumb renders one, runs unchanged. It is a focusable 129 by 16 `inline-block` box with the `slider` role and its value, `min`, `max` and `step` in the accessibility node, and nothing painted in it: a Slider draws its own track and thumb and handles the pointer, and Ghia's range does not drag. `value` (a number or numeric string), `defaultValue`, `min` (0), `max` (100) and `step` (1 or `"any"`) are sanitized as the DOM does (clamped to the limits and snapped to the step from `min`, the midpoint by default); `valueAsNumber`, `min`, `max`, `step`, `stepUp()` and `stepDown()` are properties of an `<input>` element, and a write from code fires nothing. While focused, the arrow keys, Page Up and Down, Home and End change the value unless `keydown` was canceled, firing `input` then `change`; React's `onChange` is the `input` event, in React a control with a `value` prop goes back to it after the handlers (Solid does not, as on the web), a write of `value`, `valueAsNumber`, `stepUp()` or `stepDown()` is the control's own value and no prop, and the range is in `FormData` under its sanitized value. See `docs/fork/deviations.md`.
- a5987b1: `MutationObserver` and `MutationRecord` are globals, with the standard's options, record fields and delivery (one microtask per batch, in creation order, `takeRecords`, `disconnect`, transient observers for a removed node). Both adapters report the nodes they place and remove, text changes (`characterData`) and prop changes, where an attribute is what `getAttribute` reads. With no observer alive each hook is one integer check. `queueChildListMutation`, `queueAttributeMutation`, `queueCharacterDataMutation` and `hasMutationObservers` are exported from `@ghia/native/host`.
- 1c653fa: The HTML popover API, so `@dnd-kit/dom`'s drag feedback (`popover="manual"` and `showPopover()`) works: `popover` on a `div`, `span` or HTML tag, `showPopover()`, `hidePopover()` and `togglePopover(force?)` on host elements, `beforetoggle` (cancelable on open) and a queued, coalesced `toggle` as `ToggleEvent` (a global, and exported by `@ghia/native/host`). A closed popover has no box. An open one is a `position: fixed` box centred in the window with Chrome's popover style (a user agent layer under the author's styles) and is drawn and hit in the top layer: above every sibling and `<anchored>` layer, unclipped, the one shown last on top. `popover="auto"` closes on Escape (it joins the layer stack) and on a press outside, and showing one closes the other auto popovers that do not hold it; `manual` does neither. Not built: `::backdrop`, `popovertarget`, `:popover-open` in `matches()`, anchor positioning, focus movement. A new element prop reaches native: `popover`. Native reads the open state from the custom prop `popoverOpen` (the show order), which JS sends to the renderer directly.
- e98deb3: `@ghia/react/react-dom` stands in for `react-dom`: `createPortal`, `flushSync` and `version`, as named exports and as the default export object, and nothing else. `react()` from `@ghia/react/vite` resolves the bare `react-dom` import to it, for the app and for packages in `node_modules`, under `ghia dev`, `ghia build` and vitest, so libraries that import `* as ReactDOM from 'react-dom'` (Base UI) run unchanged. `react-dom/client` and `react-dom/server` stay unresolved.
- 205828b: Stylesheets read `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` and `:popover-open`. The first five compile into the `hover`, `active`, `focus`, `focusVisible` and `focusWithin` style blocks of the element, so `.btn:hover { background: red }` is `style={{ hover: { background: 'red' } }}` on every `.btn`, with an inline value and a more specific rule beating it as in CSS. A state in a compound other than the one the rule styles (`.card:hover .title`), two states in one compound, a state inside `:not()` and an `:is()` whose arguments are under different states drop the selector. `:popover-open` matches while `showPopover()` has the popover open, in any compound. New inline style key `focus`, applied while the element is the focused one (`:focus`), under `focusWithin` and `focusVisible`.
  
  On an element with a `transition` or an `animation`, the focus styles now fold over `hover` and `active` as on any other element, and `focus` and `focusWithin` transition. What a `focus`, `focusVisible` or `focusWithin` style sets that children inherit (`color`, `fontSize`) now reaches them, with or without a transition, as in CSS. An inline `!important` value beats the element's own `hover`, `focus` and other state blocks of that property whether or not a sheet matches the element, and a state rule that overlaps an inline side border (`.a:hover { border-color: blue }` against `borderTop`) leaves the inline side as it is. `appliedBatchCount` is no longer exported from `@ghia/native/host`.
  
  A CSS-wide keyword in a state style takes back the base value while the state applies, in a rule under a state and in an inline block: `.a:hover { color: initial }` over `.a { color: red }` and `hover: { width: 'unset' }` over `width: 50` lose the base value on hover, `display: 'unset'` is `inline`, and `margin: 'revert'` on a `<p>` has the user agent margin. `inherit` on a property that does not inherit is still dropped.
- bf87967: CSS stylesheets. A `<style>` element (`<style>{css}</style>`) and constructed sheets (`new CSSStyleSheet()` in `document.adoptedStyleSheets`, with `replaceSync`, `replace`, `insertRule`, `deleteRule` and `cssRules`) style the tree, so a library that injects CSS, such as `@dnd-kit/dom`, works unchanged. Native matches type, universal, class, id and attribute selectors, `:is()`, `:where()`, `:not()`, `:root`, the four combinators, nesting and `@layer`, merges the matching declarations with the element's `style` prop (`!important` included), and matches again only the elements a class, id, attribute or tree change can reach, once at the end of each batch. The adapters send `class`, `data-*` and other attributes to native (wire op 13) for the selectors to read; wire ops 14 and 15 carry constructed sheets. Pseudo-classes other than those above, pseudo-elements and `@media`, `@keyframes`, `@container`, `@supports`, `@font-face` and `@import` are skipped; see `docs/fork/deviations.md`. `className` is no longer a prop of the native element: it is the attribute `class`.
- 0809748: Text controls fire the DOM's `input` and `change` events at the DOM's times. `input` (an `InputEvent` with `inputType`, `data`, `isComposing` and `value`, bubbling, not cancelable) fires once per edit of an `<input>` or `<textarea>`: typing, paste, cut, deletion, an input method's commit, undo and redo, and a number input's arrow step. `change` (a plain `Event` with the committed `value`, bubbling, not cancelable) fires when the user commits a changed value: on blur, before `blur` and `focusout`, when the value differs from the one at the last commit, and on Enter in an `<input>`, before its form is submitted (a number step commits itself, as in Chrome). A write to `value` from code fires neither, and drops an uncommitted edit.
  
  Breaking, Solid and native: `onChange` and `addEventListener('change')` on a text control used to fire per edit and now fire on commit; use `onInput` or `'input'` for the per-edit event (`HostInputEvent`; `onChange` gets a `HostChangeEvent`). `ComboboxInput` (Solid) reports through `onInput`. React is unchanged for apps: React DOM's `onChange` of a text control is the `input` event, so it still fires per edit, after `onInput`, and an `onChange` on a `<form>` or a `<div>` hears the edits of the text controls below it; `onChange` of a checkbox or radio is its `change`. Use `addEventListener('change')` on a ref for the commit. A `change` event is no longer an `InputEvent`: `input` is. `getTextSelection` of the native renderer no longer carries the control's text: `selectionStart`, `selectionEnd` and `selectionDirection` read only offsets, and the text has its own `getTextValue`.

### Patch Changes

- 0207da8: `document.activeElement` is `document.body` when nothing is focused, as in a browser, where it was `null`. floating-ui's focus manager (Popover, Menu, Select) returns focus to the trigger on close only when the active element is `body`, so with `null` an Escape left focus nowhere. Code that tested `document.activeElement === null` tests `=== document.body` now.
- 3fbd83c: Two Web Animations gaps `@dnd-kit/dom` hit. Removing or unmounting an element no longer cancels its `element.animate()` animations: the run goes on against the removed element, `finished` resolves on time instead of rejecting with an `AbortError`, and an element inserted again is still animating where the clock took it (its CSS animations and transitions still end with it, and, as in Chrome, `getAnimations()` of a removed element is empty). `getKeyframes()` of a transition that was retargeted while it ran (a 3D `translate`, as dnd-kit writes it) no longer throws `NotSupportedError`; a `translate` is serialized as CSS does, and `getKeyframes()` of an `element.animate()` animation reports `offset: null` for a keyframe that was given none.
- 4a1e865: `node.cloneNode(deep)` as in the DOM, on elements and text, so a library that clones the dragged element into a placeholder (`@dnd-kit/dom`'s default feedback) works: the clone has the same type, the attribute props and the live style (code-written properties included), and with `deep` the copies of the descendants. It is in no tree and has no native element until it is inserted, and neither Solid nor React updates it afterwards. It has no event handlers, no ref and no `motion` or `layout`. Adapters implement `ParentBinding.createElement` and `TextBinding.createText` on their `DOM_BINDING`, and `ElementBinding.setProp` takes a string, number or boolean.
- 3f8d04b: `<input>` and `<textarea>` have the constraint validation API: `required`, `name`, `form`, `willValidate`, `validity` (`valueMissing` and `customError`; the other conditions read `false`), `validationMessage`, `setCustomValidity()`, `checkValidity()` and `reportValidity()`. Base UI's `Field` reads `validity.valueMissing` on every change and threw `Cannot read properties of undefined (reading 'valueMissing')` as an unhandled rejection. `ValidityState` is a global. Every radio of a group with a `required` radio is `valueMissing` while none is checked (native's form check agrees), `form` and `validity` follow the `form="id"` attribute, `reportValidity()` focuses the control unless `invalid` was canceled (no message bubble), and the `ValidityState` attributes are enumerable.
- 404fff1: `document.documentElement`, `document.head`, `document.body` and `document.scrollingElement` are never `null`. While no root is mounted the document answers with its own stand-in `<html>`, `<head>` and `<body>`, which belong to no window and read as the elements of a gone window do, and a root's real ones replace it once it mounts. floating-ui's `getOffsetParent` compared `getDocumentElement(el)` with `el.offsetParent` as `null === null` after an unmount and read `null.ownerDocument`, which was an unhandled rejection.
  
  What code writes to the stand-in `<html>`, `<head>` and `<body>` before the first `render()` (attributes including `class` and `data-*`, `style`, `addEventListener` listeners) is no longer lost: when the first root mounts it is written again to that root's real elements, so `document.documentElement.setAttribute("class", "dark")` drives an `html.dark body { ... }` rule and a `keydown` listener added to `body` fires. The replaced stand-ins are then nodes in no document (`isConnected` `false`, `parentNode` `null`, not contained by `document`), where they used to claim to be connected, and the last unmount gives the document fresh ones.
- a493cf1: Code that is not the framework can build and move DOM nodes, mixed with the nodes React or Solid made, as in a browser: `document.createElement`, `createElementNS` and `createTextNode`, `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `remove`, `before`, `after`, `replaceWith`, `append`, `prepend`, `replaceChildren`, `insertAdjacentElement`, `insertAdjacentText`, and the `textContent`, `nodeValue` and `data` setters, with the DOM's return values and `DOMException` names. A node code removes is kept, and native drops its element at the next flush unless the node is back in the document by then. `MutationObserver` hears every change, and the framework's next update works on the tree the code left. Adapters implement `ParentBinding` (`assertSameWindow`, `insertBefore`, `removeChild`, `createText`, `createElement`) and `TextBinding.setData` on their `DOM_BINDING`, and register a `DomNodeFactory` with `installElementSource`. React's mutation queue now flushes in a microtask, so changes made outside a commit reach native.
- 0f1bf90: Host elements and text are real DOM-shaped nodes: `el instanceof HTMLElement`, `Element` and `Node` hold (`SVGElement` for an `<svg>` and its shapes, `Text` for text), and `parentNode`, `childNodes`, `children`, the sibling members, `contains`, `getRootNode`, `compareDocumentPosition`, `textContent`, `tagName`, `localName`, `className`, `hasAttribute`, `getAttributeNames` and `dataset` answer as in a browser. `document` is a `Document`. The classes are exported by `@ghia/native/host` and installed as globals where the runtime has none. Solid's `HostElement.children` is now `childList`, because `children` is the DOM's elements-only list.
- bbc26f7: `element.animate(keyframes, options)` as in the Web Animations API, so `@dnd-kit/dom` runs unchanged: keyframes as an array of objects or one object of arrays (`{ translate: [from, to] }`), a duration or `delay`, `endDelay`, `duration`, `iterations`, `iterationStart`, `direction`, `fill`, `easing` and `id`. It returns the same `Animation` `getAnimations()` lists, with `pause()`, `finish()`, `cancel()`, `finished` and the rest, sampled by the engine of CSS animations and playing above them. `composite: "add"` and `"accumulate"`, `commitStyles()` and `persist()` are not built.
- 4572e56: `element.classList` is a live `DOMTokenList` over the `class` attribute (`add`, `remove`, `toggle` with `force`, `replace`, `contains`, `item`, `length`, `value`, iteration, `toString()`). It writes through the same path as `setAttribute('class')`, so stylesheets and `MutationObserver` see it, and it works on mounted, created and stand-in elements. `DOMTokenList` is a global. Libraries that toggle a `dark` class on `document.documentElement` with `classList` no longer throw.
- 3cc3b0b: Host elements have `addEventListener` and `removeEventListener` for any event type (`capture`, `once`, `passive` and `signal`; the `on*` prop is an entry of the same list, ordered as the DOM orders an event handler attribute), `ownerDocument`, `isConnected`, `getAttribute`, `offsetWidth` and `offsetHeight` (the layout size, before any transform; the native `ElementBounds` carries it as `layoutWidth` and `layoutHeight`), and `document.defaultView` is the global `window`. `requestAnimationFrame` and `cancelAnimationFrame` are globals whose callbacks run in the window's frame steps, after the scroll events and before the frame that paints what they change, and `ResizeObserver` is a global where the runtime has none. Libraries written for the DOM, such as TanStack Virtual, can attach to an element and a window without an adapter.
- 0925cff: `element.style` is a `CSSStyleDeclaration` over the live style of an element, so code can write the styles a framework renders, as `@dnd-kit/dom` does: `setProperty`, `removeProperty` (which returns the old value), `getPropertyValue`, `cssText`, `length`, `item()`, iteration, and a camelCase member for every style property (`el.style.translate = "4px"`), custom properties included. A write from code and the framework's next `style` update are one style: the framework's change is applied property by property onto the live style, so a re-render keeps what code wrote to other properties, overwrites a property it changes and removes one it drops. `getAttribute("style")` is the `cssText`, `getAttributeNames()` lists `style`, and a change of the style makes a `MutationObserver` `attributes` record. `el.id = "x"` sets the `id` prop. Adapters implement `style`, `setStyle` and `setProp` on their `ElementBinding`.
- 7785655: A throw while a frame's changes are flushed no longer stops the later flushes. Releasing removed nodes and sending the batch are guarded apart, so a throw in the first never skips the second, and Solid's `finishRemovals` and React's `releaseDetachedNodes` release every node and then rethrow, as one error or an `AggregateError`. A Solid root without `onUncaughtError` now reports the errors of a scheduled flush, and native errors, with `console.error`, as React already did; `root.render()`, `flush()`, `flushSync()`, `dispatch()` and `unmount()` of a Solid root, and `unmount()` of a React root, run all of their work and then rethrow to the caller: the one error, or an `AggregateError`, and `flushSync(fn)` and `dispatch` flush even when `fn` throws. A throwing `onCleanup` no longer leaves a Solid root unable to render again. `@ghia/native/host` exports `runAll`, `runSteps` and `runThenAlways`, the helpers both adapters use.
- 4dcfbbf: A full reload under `ghia dev` unmounts the roots (and keeps the window) before it runs the entry again, as a page reload does. What the entry writes to `document` before `render()` (`document.documentElement.classList.add("dark")`, `document.body.addEventListener(...)`) used to land on the outgoing root's `<html>` and `<body>`, which `render()` then destroyed; it now goes to the stand-ins and carries to the new root's elements once. `@ghia/native/roots` exports `unmountAllRoots()`, and `registerRoot()` is how an adapter's root joins it. A `stop` that throws is logged and the reload goes on.
- 86435ae: Host element types follow the DOM's, so code and libraries typed for React DOM or solid-js check unchanged. React host elements take `className` (the `class` attribute stylesheets match, which `stylex.props()` spreads) and `<style>` is a JSX element; Solid host elements take `class` and `classList`. A host `ref` takes a ref object of the tag's DOM interface (`useRef<HTMLDivElement>` on a `div`) or of Ghia's instance type, and a callback ref is given the element as both, so TanStack Virtual's `measureElement` and `getScrollElement` need no cast. `DomElementOf<Tag>` (`@ghia/native/host`) maps a tag to its lib.dom interface, and `@ghia/react` exports `HostRef`, `TextControlInstance` and `FormInstance`. `motion.*` components take the `ref` of the tag they render, and `motion.div` takes `className`. `jsx-dev-runtime` shares `jsx-runtime`'s JSX types, which gives it `<span>`, and both now import with `.js` extensions, so the JSX types also resolve under `moduleResolution: "nodenext"`, where they used to be `any`. `AnchoredProps.style` (React) takes motion values, as a `div`'s does.
  
  Type changes that can break a build: `JSX.IntrinsicElements[tag]` props in React now carry the tag's `ref`, which does not fit Ghia's own components (still `Ref<PublicInstance>`); a callback ref typed narrower than the tag's instance (`(el: TextControlInstance) => …` on a `div`) no longer fits; under `nodenext` the JSX props are checked where they were `any`; and in Solid a `<li>` callback ref's `value` is `never` (Ghia's `string` against lib.dom's `number`).
- d636ace: `selectionStart`, `selectionEnd` and `selectionDirection` of an `<input>` of type `checkbox`, `radio`, `range` or `hidden` are `null`, `select()` does nothing and `setSelectionRange()` throws `InvalidStateError`, as in the DOM. They threw `Element N has no text selection`, which broke a Base UI `RadioGroup` (its composite list reads `selectionStart` of every item that takes focus).
- bc7a267: Key and focus events have capture-phase props: `onKeyDownCapture`, `onKeyUpCapture`, `onFocusCapture` and `onBlurCapture` (React: the capture phase of `focusin` and `focusout`, as React DOM has), and `onFocusInCapture` and `onFocusOutCapture` in Solid. A handler of a capture prop used to be dropped silently. Base UI's `RadioGroup` marks an arrow key press in `onKeyDownCapture`, and without it the arrow keys moved focus between radios but never selected one.
- ff24328: A key pressed with nothing focused targets `document.body` and bubbles body, html, document, window, as in a browser, where it went to `window` alone with `target === null`. `event.target === document.body` and `event.target.closest(...)` work, and `preventDefault()` on a `body` or `html` listener cancels Tab's focus move and the scrolling keys.
- aaea77f: `selectionStart`, `selectionEnd` and `selectionDirection` of an `<input>` are `null` and `setSelectionRange()` throws `InvalidStateError` for every type except `text`, `search`, `url`, `tel` and `password`, as HTML says; `select()` still selects all text on `email`, `number` and the other types HTML applies it to, and does nothing on `checkbox`, `radio`, `range`, `hidden` and the buttons. `email`, `number`, `date` and the others used to have a selection. The `type` is read trimmed and lowercased, as native does, with an unknown keyword counting as `text`.
- 7ae7555: DOM gaps that headless Solid libraries (Kobalte, Base UI ports) hit. `input.value`, `checked`, `indeterminate` and `textarea.value` can be assigned before the element is mounted: the write is the control's own state, as after the mount (reads give it back; it changes no attribute and not `defaultValue` or `defaultChecked`, so `getAttribute`, `[checked]` and a `MutationObserver` see nothing), and the control gets it when it mounts (it used to throw "needs a mounted element"). `select()`, `setSelectionRange()` and `selectionStart`, `selectionEnd` and `selectionDirection` on an unmounted Solid text control answer from a selection kept on the element instead of throwing. `getElementsByTagName` and `getElementsByClassName` on elements and `document`, and `document.getElementsByName`, return live `HTMLCollection` and `NodeList` lists (also on `document.head` before a root mounts), and `HTMLCollection` and `NodeList` are globals. Assigning `className` sets the `class` attribute.
  
  More gaps from running Kobalte unmodified. `<label for>` written by Solid's JSX is the label's `htmlFor`, so a click on the label toggles the control it names. `input.type` and `button.type` read the `type` attribute (a host node's `tag` field is now `elementType`, and the stand-in `<html>`, `<head>` and `<body>` of a document with no root have no `type` property: `document.body.type` is `undefined`). `NodeFilter`, `TreeWalker` and `document.createTreeWalker(root, whatToShow, filter)` exist, with the standard's `FILTER_ACCEPT`, `FILTER_REJECT` and `FILTER_SKIP` rules (Kobalte's focus scope, `ariaHideOutside` and menus walk the tree with them); `createNodeIterator` does not. `input.placeholder` and `textarea.placeholder` reflect the `placeholder` attribute.
  
  `HTMLButtonElement` is a global (and exported) beside `HTMLInputElement` and `HTMLTextAreaElement`: `el instanceof HTMLButtonElement` holds for a `<button>` and no other element (the Base UI ports' `useButton` checks it).
  
  A prop that leaves a Solid spread is removed. `<div {...(open() ? { "data-open": "" } : {})} />` and `<Dynamic component="div" {...props()} />` used to keep `data-open` (and an `onClick`, an `aria-*`, a `style`) after the key was gone, because `solid-js/universal`'s `spread` only visits the keys it has now; Ghia's spread takes them away as `solid-js/web` does.
  
  `element.focus()` does nothing on an element that is not rendered, as in a browser, where it leaves `document.activeElement` alone. It used to focus it (a Select's popup inside a `hidden` positioner took focus back from the trigger). It decides in one native call that walks the ancestors once and forces no layout; it refuses `display: none` on the element or an ancestor (its `style`, a stylesheet rule or the `hidden` attribute), `visibility: hidden` and `collapse` (also through `inherit` and `unset`), content inside `content-visibility: hidden` and an element inside an `inert` subtree, as Chrome does, while a `visibility: visible` element inside a hidden parent still takes focus. The queued mutations are sent first, so an element mounted or shown in the same tick is still focusable. `renderer.focusElement(id)` returns whether focus was asked for.
  
  Children that change through a Solid spread replace the nodes they inserted before. `<Dynamic component="div">{tab() === 1 ? <List /> : <Detail />}</Dynamic>` (and `{...props()}` with a `children` key) used to keep the old nodes and append the new ones.
  
  The lists `getElementsByTagName`, `getElementsByClassName` and `getElementsByName` return keep what they found until the tree or an attribute changes (one counter for the whole document, moved by every insert, remove, root mount or unmount and prop write), so a loop over `length` and `list[index]` walks the tree once instead of once per access. `classList`, `HTMLCollection` and `NodeList` share one indexed-view helper.
  
  `querySelectorAll` returns a static `NodeList` (`instanceof NodeList`, `item`, `forEach`, `keys`, `values`, `entries`, iteration), not an `Array` subclass: it has no `map` or `filter`, as in a browser; `Array.from(list)` makes an array. `children` and `childNodes` stay arrays (listed in the deviations).
  
  `render(code, element)` from `@ghia/solid/web` keeps the children `element` already has, as `solid-js/web`'s does (it used to remove all of them, so a `<Show>` that went false inside `render(..., document.body)` emptied the app). It takes `init` and `options.owner`, `render(..., document)` runs the code under a root, an element that is not of this window's document throws a `TypeError`, and `spread` returns the props it wrote.
  
  An attribute written to the stand-in `<html>`, `<head>` or `<body>` before the first `render()` (`document.documentElement.classList.add("dark")`) updates the live lists (`document.getElementsByClassName("dark")` finds it) and gives a `MutationObserver` on it a record.
  
  A live list drops the elements it found at the next change to the tree instead of holding them until it is read again.
  
  A layer's `initialFocus` and `finalFocus` target, and the focus a Select or Combobox gives back or takes, is judged by the tree as the update left it: the queued mutations are sent before `focusElement`, so a target mounted, shown or made focusable in the same update takes focus. `focusElementById(renderer, id)` is exported from `@ghia/native/host` for code that holds an id.
  
  A `<label>` that React is given `for` (a library's JSX, an untyped spread) names its control as in a browser, where React DOM sets the attribute: `@ghia/react` sets it as `htmlFor`, as `@ghia/solid` does.
- 8cec6c4: An element used after its window is gone no longer throws or reaches another window. The test renderer after `dispose()` or after the next test renderer replaced it, and a live renderer after its window closed, answer `getBoundingClientRect`, `getComputedStyle`, `focus()`, `blur()`, scrolling, pointer capture, `matches(":focus")`, style, attribute and listener writes and observers as a node that is not in a document does, so Base UI's focus return and floating-ui's measuring after `unmount()` are harmless; an earlier test's `focus()` used to focus the element with the same id in the next test's window. `focus()` and `blur()` of a Solid element that is not mounted do nothing instead of throwing. Event handlers called from native stop nesting at 16 levels and throw `Maximum call stack size exceeded`, where two focus handlers that moved focus to each other ran the process out of stack and napi's `Error::from(Unknown)` recursed until it aborted.
- Updated dependencies [0207da8]
- Updated dependencies [3fbd83c]
- Updated dependencies [7a2b5a8]
- Updated dependencies [80a3be4]
- Updated dependencies [530acb9]
- Updated dependencies [4a1e865]
- Updated dependencies [f016dcd]
- Updated dependencies [3f8d04b]
- Updated dependencies [4c17914]
- Updated dependencies [17a52f2]
- Updated dependencies [9ee7f29]
- Updated dependencies [404fff1]
- Updated dependencies [108927a]
- Updated dependencies [f2bef8f]
- Updated dependencies [a493cf1]
- Updated dependencies [3452f68]
- Updated dependencies [18c692c]
- Updated dependencies [947501e]
- Updated dependencies [0f1bf90]
- Updated dependencies [1d7829a]
- Updated dependencies [ec44f9b]
- Updated dependencies [cccd1c5]
- Updated dependencies [b08d26b]
- Updated dependencies [bbc26f7]
- Updated dependencies [4572e56]
- Updated dependencies [4abfea9]
- Updated dependencies [3cc3b0b]
- Updated dependencies [0925cff]
- Updated dependencies [59be768]
- Updated dependencies [7785655]
- Updated dependencies [4dcfbbf]
- Updated dependencies [86435ae]
- Updated dependencies [75aa218]
- Updated dependencies [fb29c70]
- Updated dependencies [04d2672]
- Updated dependencies [d636ace]
- Updated dependencies [61a5e5b]
- Updated dependencies [bc7a267]
- Updated dependencies [ff24328]
- Updated dependencies [65419e0]
- Updated dependencies [6c10302]
- Updated dependencies [a5987b1]
- Updated dependencies [b7cb690]
- Updated dependencies [1c653fa]
- Updated dependencies [4fcc0be]
- Updated dependencies [2e44be5]
- Updated dependencies [dbff079]
- Updated dependencies [aaea77f]
- Updated dependencies [205828b]
- Updated dependencies [7ae7555]
- Updated dependencies [8cec6c4]
- Updated dependencies [7fd691e]
- Updated dependencies [bf87967]
- Updated dependencies [0809748]
- Updated dependencies [2b472be]
  - @ghia/native@0.13.0
  - ghia@0.13.0

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

- 4c7d9c6: A React app has the `window`, `document` and no-op `scrollTo` globals in the native build, because the renderer imports `@ghia/native/host`, and `@ghia/react` re-exports `isWebBuild` from it. The renderer tells the wasm build from the native one with `isWebBuild` instead of `typeof window`.
- 9d68f3b: `@ghia/react/vite` exports `react()`: @vitejs/plugin-react's JSX transform with the automatic runtime and `jsxImportSource: "@ghia/react"`, and React Fast Refresh in `ghia dev`. An edit to a component module updates the tree in place and keeps the `useState` of the components around it, and the entry does not run again; any other edit re-runs the entry, and refresh still works after it. Use it next to `ghia()` in the Vite config, and run React apps with `ghia dev` and `ghia build` instead of `bun --hot`. `react({ include, exclude })` scopes it to some files, for an app that also uses `solid()`. `ghia` and `vite` are optional peer dependencies, as for `@ghia/solid`.

### Patch Changes

- 751f7e2: After the entry is evaluated again, runtime errors from the native renderer, the frame loop and the process handlers are reported by the latest `render()` call's module, so the error overlay no longer mounts through the first run's copy of the reconciler.
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
