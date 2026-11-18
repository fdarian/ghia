---
"@ghia/native": minor
---

Cmd+C, Cmd+X, Cmd+V and Cmd+A, and a new Edit menu (Cut, Copy, Paste, Select All), run as one set of GPUI actions. Outside an `<input>` or `<textarea>` they fire the DOM `copy`, `cut` and `paste` events at the focused editing host, the element of the selection, or the active element, with a `DataTransfer` in the mode the Clipboard API gives it; a cancelled `copy` or `cut` writes exactly what the handler put in `clipboardData`, and an uncancelled `copy` writes `text/plain` and `text/html` of the node selection (a text selected by dragging is still copied as before). A `preventDefault` on the `keydown` cancels the command. Select All selects the focused editing host, or the body. Cut and paste have no default in an editing host yet. `TestRenderer.simulateMenuAction(name)` chooses an Edit menu item. `<input>` and `<textarea>` fire no clipboard events: `docs/fork/deviations.md`.
