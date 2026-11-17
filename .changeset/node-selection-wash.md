---
"@ghia/native": minor
---

A node selection inside an editing host is painted: the text between its two points gets a selection wash in every paragraph it reaches, in the colour of a dragged selection. Changing the selection builds only the paragraphs it touches (retention skips the rest). The selection goes to native in the mutation batch (`setNodeSelection`, wire opcode 16). The caret is still not painted.
