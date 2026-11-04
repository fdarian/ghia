---
'@ghia/native': patch
---

`:focus-visible` after a script focus (`focus()`, `autoFocus`, `focusElement`) now follows Chrome. It used to inherit the visible state of the element focus left, plus "no input yet"; Chrome keeps two window-wide facts instead: a mouse press that moves focus marks it as the mouse's and clears the last key, a key down (Shift alone too, not Ctrl, Alt or Cmd) sets the key, and a script focus changes neither. So a script focus now shows the ring after a press on blank body, and after Tab then a click on blank body, and no longer shows it when a text field was script-focused after a click.
