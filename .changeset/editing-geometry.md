---
"@ghia/native": minor
"@ghia/react": patch
"@ghia/solid": patch
---

`Range.getClientRects()` and `getBoundingClientRect()` are the rects of the selected text, one for each painted line of each Text node and the border box of each element the range selects whole, and a collapsed range in text is the caret rect. `document.caretPositionFromPoint(x, y)` (with the `CaretPosition` global) and `document.caretRangeFromPoint(x, y)` give the text position nearest a point. `Selection.modify` takes the `line`, `lineboundary` and `documentboundary` granularities: moves by line keep the caret's x across a short line. Native has three new reads for them (`getTextRangeRects`, `caretPositionFromPoint`, `moveCaretVisually`).
