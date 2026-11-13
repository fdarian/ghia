---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Host element types follow the DOM's, so code and libraries typed for React DOM or solid-js check unchanged. React host elements take `className` (the `class` attribute stylesheets match, which `stylex.props()` spreads) and `<style>` is a JSX element; Solid host elements take `class` and `classList`. A host `ref` takes a ref object of the tag's DOM interface (`useRef<HTMLDivElement>` on a `div`) or of Ghia's instance type, and a callback ref is given the element as both, so TanStack Virtual's `measureElement` and `getScrollElement` need no cast. `DomElementOf<Tag>` (`@ghia/native/host`) maps a tag to its lib.dom interface, and `@ghia/react` exports `HostRef`, `TextControlInstance` and `FormInstance`. `motion.*` components take the `ref` of the tag they render, and `motion.div` takes `className`. `jsx-dev-runtime` shares `jsx-runtime`'s JSX types, which gives it `<span>`, and both now import with `.js` extensions, so the JSX types also resolve under `moduleResolution: "nodenext"`, where they used to be `any`. `AnchoredProps.style` (React) takes motion values, as a `div`'s does.

Type changes that can break a build: `JSX.IntrinsicElements[tag]` props in React now carry the tag's `ref`, which does not fit Ghia's own components (still `Ref<PublicInstance>`); a callback ref typed narrower than the tag's instance (`(el: TextControlInstance) => …` on a `div`) no longer fits; under `nodenext` the JSX props are checked where they were `any`; and in Solid a `<li>` callback ref's `value` is `never` (Ghia's `string` against lib.dom's `number`).
