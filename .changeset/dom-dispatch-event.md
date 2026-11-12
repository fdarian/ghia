---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`element.dispatchEvent(event)` and `document.dispatchEvent(event)`: any runtime `Event` (`new Event`, `new CustomEvent`, the new `PointerEvent` and the other event classes) walks capture, target and bubble through the element's ancestors, and `window` and `document` around them, and is heard by `on*` props, Solid handlers and `addEventListener` listeners with `isTrusted` false. It returns `!event.defaultPrevented`, throws an `InvalidStateError` for an event already being dispatched, and a dispatched `focusin` reaches React's `onFocus`. An uncanceled `click` that is a `MouseEvent` then runs the element's activation behaviour: a label focuses its control and a submit button submits its form (native `activateElement`). Checkbox and radio toggling is a later slice. So Base UI's `new (ownerWindow(el).PointerEvent)('click', { ...modifiers })` and `el.dispatchEvent(event)` work. A rejected dispatch (an event already being dispatched) happens before the click's pre-activation, so it toggles no checkbox.
