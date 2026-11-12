---
"@ghia/native": patch
"@ghia/react": patch
"@ghia/solid": patch
---

Key and focus events have capture-phase props: `onKeyDownCapture`, `onKeyUpCapture`, `onFocusCapture` and `onBlurCapture` (React: the capture phase of `focusin` and `focusout`, as React DOM has), and `onFocusInCapture` and `onFocusOutCapture` in Solid. A handler of a capture prop used to be dropped silently. Base UI's `RadioGroup` marks an arrow key press in `onKeyDownCapture`, and without it the arrow keys moved focus between radios but never selected one.
