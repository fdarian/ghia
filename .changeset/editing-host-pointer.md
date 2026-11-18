---
"@ghia/native": minor
---

A click in a `contenteditable` host puts the caret at the character under the pointer and focuses the host with the selection already there, Shift+click extends the focus, and a drag selects from the press to the pointer, clamped to the host. A double click selects the word, a triple click the contents of the paragraph, and a drag after either extends by words or paragraphs. The selection is a node selection, so it is painted as the caret or the wash, `selectionchange` fires and a framework editor (Lexical) reads it; a prevented `mousedown` changes nothing, and a press outside every editing host still selects painted text. No auto-scroll at the edge while dragging in a host and no `selectstart` yet: see `docs/fork/deviations.md`.
