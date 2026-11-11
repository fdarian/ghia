---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

`node.cloneNode(deep)` as in the DOM, on elements and text, so a library that clones the dragged element into a placeholder (`@dnd-kit/dom`'s default feedback) works: the clone has the same type, the attribute props and the live style (code-written properties included), and with `deep` the copies of the descendants. It is in no tree and has no native element until it is inserted, and neither Solid nor React updates it afterwards. It has no event handlers, no ref and no `motion` or `layout`. Adapters implement `ParentBinding.createElement` and `TextBinding.createText` on their `DOM_BINDING`, and `ElementBinding.setProp` takes a string, number or boolean.
