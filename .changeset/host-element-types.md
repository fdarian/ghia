---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Host element types follow the DOM's, so code and libraries typed for React DOM or solid-js check unchanged. React host elements take `className` (the `class` attribute stylesheets match, which `stylex.props()` spreads) and `<style>` is a JSX element; Solid host elements take `class` and `classList`. A host `ref` takes a ref object of the tag's DOM interface (`useRef<HTMLDivElement>` on a `div`) or of Ghia's instance type, and a callback ref is given the element as both, so TanStack Virtual's `measureElement` and `getScrollElement` need no cast. `DomElementOf<Tag>` (`@ghia/native/host`) maps a tag to its lib.dom interface, and `@ghia/react` exports `HostRef`, `TextControlInstance` and `FormInstance`. `jsx-dev-runtime` shares `jsx-runtime`'s JSX types, which gives it `<span>`.
