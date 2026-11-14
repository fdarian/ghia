---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

DOM gaps that headless Solid libraries (Kobalte, Base UI ports) hit. `input.value`, `checked`, `indeterminate` and `textarea.value` can be assigned before the element is mounted: the write is the control's own state, as after the mount (reads give it back; it changes no attribute and not `defaultValue` or `defaultChecked`, so `getAttribute`, `[checked]` and a `MutationObserver` see nothing), and the control gets it when it mounts (it used to throw "needs a mounted element"). `select()`, `setSelectionRange()` and `selectionStart`, `selectionEnd` and `selectionDirection` on an unmounted Solid text control answer from a selection kept on the element instead of throwing. `getElementsByTagName` and `getElementsByClassName` on elements and `document`, and `document.getElementsByName`, return live `HTMLCollection` and `NodeList` lists (also on `document.head` before a root mounts), and `HTMLCollection` and `NodeList` are globals. Assigning `className` sets the `class` attribute.

More gaps from running Kobalte unmodified. `<label for>` written by Solid's JSX is the label's `htmlFor`, so a click on the label toggles the control it names. `input.type` and `button.type` read the `type` attribute (a host node's `tag` field is now `elementType`, and the stand-in `<html>`, `<head>` and `<body>` of a document with no root have no `type` property: `document.body.type` is `undefined`). `NodeFilter`, `TreeWalker` and `document.createTreeWalker(root, whatToShow, filter)` exist, with the standard's `FILTER_ACCEPT`, `FILTER_REJECT` and `FILTER_SKIP` rules (Kobalte's focus scope, `ariaHideOutside` and menus walk the tree with them); `createNodeIterator` does not. `input.placeholder` and `textarea.placeholder` reflect the `placeholder` attribute.

`HTMLButtonElement` is a global (and exported) beside `HTMLInputElement` and `HTMLTextAreaElement`: `el instanceof HTMLButtonElement` holds for a `<button>` and no other element (the Base UI ports' `useButton` checks it).

A prop that leaves a Solid spread is removed. `<div {...(open() ? { "data-open": "" } : {})} />` and `<Dynamic component="div" {...props()} />` used to keep `data-open` (and an `onClick`, an `aria-*`, a `style`) after the key was gone, because `solid-js/universal`'s `spread` only visits the keys it has now; Ghia's spread takes them away as `solid-js/web` does.

`element.focus()` does nothing on an element that is not rendered, as in a browser, where it leaves `document.activeElement` alone. It used to focus it (a Select's popup inside a `hidden` positioner took focus back from the trigger). It decides in one native call that walks the ancestors once and forces no layout; it refuses `display: none` on the element or an ancestor (its `style`, a stylesheet rule or the `hidden` attribute), `visibility: hidden` and `collapse` on the element and an element inside an `inert` subtree, as Chrome does, while a `visibility: visible` element inside a hidden parent still takes focus. The queued mutations are sent first, so an element mounted or shown in the same tick is still focusable. `renderer.focusElement(id)` returns whether focus was asked for.

Children that change through a Solid spread replace the nodes they inserted before. `<Dynamic component="div">{tab() === 1 ? <List /> : <Detail />}</Dynamic>` (and `{...props()}` with a `children` key) used to keep the old nodes and append the new ones.

The lists `getElementsByTagName`, `getElementsByClassName` and `getElementsByName` return keep what they found until the tree or an attribute changes (one counter for the whole document, moved by every insert, remove, root mount or unmount and prop write), so a loop over `length` and `list[index]` walks the tree once instead of once per access. `classList`, `HTMLCollection` and `NodeList` share one indexed-view helper.

`querySelectorAll` returns a static `NodeList` (`instanceof NodeList`, `item`, `forEach`, `keys`, `values`, `entries`, iteration), not an `Array` subclass: it has no `map` or `filter`, as in a browser; `Array.from(list)` makes an array. `children` and `childNodes` stay arrays (listed in the deviations).

`render(code, element)` from `@ghia/solid/web` keeps the children `element` already has, as `solid-js/web`'s does (it used to remove all of them, so a `<Show>` that went false inside `render(..., document.body)` emptied the app). It takes `init` and `options.owner`, `render(..., document)` runs the code under a root, an element that is not of this window's document throws a `TypeError`, and `spread` returns the props it wrote.

An attribute written to the stand-in `<html>`, `<head>` or `<body>` before the first `render()` (`document.documentElement.classList.add("dark")`) updates the live lists (`document.getElementsByClassName("dark")` finds it) and gives a `MutationObserver` on it a record.

A live list drops the elements it found at the next change to the tree instead of holding them until it is read again.
