---
"@ghia/native": patch
"@ghia/solid": patch
---

A style object typed as solid-js's `JSX.CSSProperties` (csstype, whose lengths are `string | 0`) is assignable to the `style` of a Solid host element, so a web library's `visuallyHidden` style needs no cast. `mask` takes a number (px, so `0` is no mask), and `border`, `outline`, `translate`, `background` and `animation` take a number, `opacity` and `order` a string, `direction` and `cursor` any string, as csstype types them; the runtime already read these (a number as React DOM writes it, `lenient.rs`). A type test in `@ghia/solid` type-checks it.
