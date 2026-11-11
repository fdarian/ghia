---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

The HTML popover API, so `@dnd-kit/dom`'s drag feedback (`popover="manual"` and `showPopover()`) works: `popover` on a `div`, `span` or HTML tag, `showPopover()`, `hidePopover()` and `togglePopover(force?)` on host elements, `beforetoggle` (cancelable on open) and a queued, coalesced `toggle` as `ToggleEvent` (a global, and exported by `@ghia/native/host`). A closed popover has no box. An open one is a `position: fixed` box centred in the window with Chrome's popover style (a user agent layer under the author's styles) and is drawn and hit in the top layer: above every sibling and `<anchored>` layer, unclipped, the one shown last on top. `popover="auto"` closes on Escape (it joins the layer stack) and on a press outside, and showing one closes the other auto popovers that do not hold it; `manual` does neither. Not built: `::backdrop`, `popovertarget`, `:popover-open` in `matches()`, anchor positioning, focus movement. A new element prop reaches native: `popover`. Native reads the open state from the custom prop `popoverOpen` (the show order), which JS sends to the renderer directly.
