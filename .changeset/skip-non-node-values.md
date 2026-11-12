---
"@ghia/solid": patch
---

A Solid component that renders an object that is not a host node (solid-refresh makes a component that threw on mount render `{ name }` in dev) is skipped with `console.warn("Unrecognized value. Skipped inserting", value)`, as `solid-js/web` does. It used to be half-mounted: it stayed in its parent's child list and made every later flush throw in `markUnmounted`, so the window stopped updating.
