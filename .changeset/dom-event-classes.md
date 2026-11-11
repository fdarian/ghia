---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

The events Ghia delivers are instances of the DOM's event classes: `click` and the pointer types are `PointerEvent`, the other mouse types `MouseEvent`, `wheel` `WheelEvent`, the drag types `DragEvent`, `keydown`/`keyup` `KeyboardEvent`, the focus types `FocusEvent`, `onChange`'s event an `InputEvent`, and the composition, transition and animation types their classes, all `instanceof Event` and `isTrusted` `true`. The classes (`UIEvent`, `MouseEvent`, `PointerEvent`, `WheelEvent`, `DragEvent`, `KeyboardEvent`, `FocusEvent`, `InputEvent`, `CompositionEvent`, `TransitionEvent`, `AnimationEvent`) are exported by `@ghia/native/host` and installed as globals where the runtime has none, with the DOM's constructor init dictionaries and defaults, so `new (element.ownerDocument.defaultView.PointerEvent)('click', { shiftKey: true })` works. `getModifierState('Shift' | 'Control' | 'Alt' | 'Meta')` is on mouse, pointer, wheel, drag and keyboard events, and every mouse event has `shiftKey`, `ctrlKey`, `altKey` and `metaKey`. A delivered event is built without the runtime's `Event` constructor, so its inherited native methods such as `initEvent` throw and it cannot be passed to a runtime `EventTarget`'s `dispatchEvent`; see `docs/fork/deviations.md`.
