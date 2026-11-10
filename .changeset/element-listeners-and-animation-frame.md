---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Host elements have `addEventListener` and `removeEventListener` for any event type (`capture`, `once`, `passive` and `signal`; the `on*` prop is an entry of the same list, ordered as the DOM orders an event handler attribute), `ownerDocument`, `isConnected`, `getAttribute`, `offsetWidth` and `offsetHeight` (the layout size, before any transform; the native `ElementBounds` carries it as `layoutWidth` and `layoutHeight`), and `document.defaultView` is the global `window`. `requestAnimationFrame` and `cancelAnimationFrame` are globals whose callbacks run in the window's frame steps, after the scroll events and before the frame that paints what they change, and `ResizeObserver` is a global where the runtime has none. Libraries written for the DOM, such as TanStack Virtual, can attach to an element and a window without an adapter.
