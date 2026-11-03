---
'@ghia/native': patch
---

`:focus-visible` (`focusVisible` and `hasFocusVisible`) no longer depends on `transition`. An element with any `transition*` ignored the focus ring when a script focused it before a key was pressed (autofocus, a dialog's first focus, `focusElement`), and a text field focused by a click lost it too, because the transition path read the window's last input device instead of the focus state the element without a transition uses. A `focusVisible` style on a transitioned element now matches in the same cases as on a plain one, and still transitions in.
