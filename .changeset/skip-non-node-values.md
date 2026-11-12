---
"@ghia/solid": patch
---

A Solid component that renders an object that is not a host node (solid-refresh makes a component that threw on mount render `{ name }` in dev, once an `ErrorBoundary` or `catchError` caught the throw) renders nothing in its place and warns once per object with `console.warn("Unrecognized value. Rendered nothing in its place", value)`. An empty text node stands for the object (one per root), so the fragments and lists around it keep their positions; see `docs/fork/deviations.md`. It used to be half-mounted: it stayed in its parent's child list and made every later flush throw in `markUnmounted`, so the window stopped updating. Host nodes carry a `Symbol.for("@ghia/solid/host-node")` brand, so an app's own `{ kind: "text" }` object is not taken for one.
