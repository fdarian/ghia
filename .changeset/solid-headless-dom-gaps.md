---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

DOM gaps that headless Solid libraries (Kobalte, Base UI ports) hit. `input.value`, `checked`, `indeterminate` and `textarea.value` can be assigned before the element is mounted: the write is kept, reads give it back, and the control shows it once mounted (it used to throw "needs a mounted element"). `select()`, `setSelectionRange()` and `selectionStart`, `selectionEnd` and `selectionDirection` on an unmounted Solid text control answer from a selection kept on the element instead of throwing. `getElementsByTagName` and `getElementsByClassName` on elements and `document`, and `document.getElementsByName`, return live `HTMLCollection` and `NodeList` lists (also on `document.head` before a root mounts), and `HTMLCollection` and `NodeList` are globals. Assigning `className` sets the `class` attribute.

More gaps from running Kobalte unmodified. `<label for>` written by Solid's JSX is the label's `htmlFor`, so a click on the label toggles the control it names. `input.type` and `button.type` read the `type` attribute (a host node's `tag` field is now `elementType`, and the stand-in `<html>`, `<head>` and `<body>` of a document with no root have no `type` property: `document.body.type` is `undefined`). `NodeFilter`, `TreeWalker` and `document.createTreeWalker(root, whatToShow, filter)` exist, with the standard's `FILTER_ACCEPT`, `FILTER_REJECT` and `FILTER_SKIP` rules (Kobalte's focus scope, `ariaHideOutside` and menus walk the tree with them); `createNodeIterator` does not. `input.placeholder` and `textarea.placeholder` reflect the `placeholder` attribute.

`HTMLButtonElement` is a global (and exported) beside `HTMLInputElement` and `HTMLTextAreaElement`: `el instanceof HTMLButtonElement` holds for a `<button>` and no other element (the Base UI ports' `useButton` checks it).

A prop that leaves a Solid spread is removed. `<div {...(open() ? { "data-open": "" } : {})} />` and `<Dynamic component="div" {...props()} />` used to keep `data-open` (and an `onClick`, an `aria-*`, a `style`) after the key was gone, because `solid-js/universal`'s `spread` only visits the keys it has now; Ghia's spread takes them away as `solid-js/web` does.

`element.focus()` does nothing on an element that is not rendered: `display: none` on it or an ancestor (its `style`, a stylesheet rule or the `hidden` attribute), as in a browser, where it leaves `document.activeElement` alone. It used to focus it (a Select's popup inside a `hidden` positioner took focus back from the trigger). The check reads computed `display` of the element and its ancestors after sending the queued mutations, so an element mounted or shown in the same tick is still focusable.

Children that change through a Solid spread replace the nodes they inserted before. `<Dynamic component="div">{tab() === 1 ? <List /> : <Detail />}</Dynamic>` (and `{...props()}` with a `children` key) used to keep the old nodes and append the new ones.
