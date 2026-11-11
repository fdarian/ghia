---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`element.style` is a `CSSStyleDeclaration` over the live style of an element, so code can write the styles a framework renders, as `@dnd-kit/dom` does: `setProperty`, `removeProperty` (which returns the old value), `getPropertyValue`, `cssText`, `length`, `item()`, iteration, and a camelCase member for every style property (`el.style.translate = "4px"`), custom properties included. A write from code and the framework's next `style` update are one style: the framework's change is applied property by property onto the live style, so a re-render keeps what code wrote to other properties, overwrites a property it changes and removes one it drops. `getAttribute("style")` is the `cssText`, `getAttributeNames()` lists `style`, and a change of the style makes a `MutationObserver` `attributes` record. `el.id = "x"` sets the `id` prop. Adapters implement `style`, `setStyle` and `setProp` on their `ElementBinding`.
