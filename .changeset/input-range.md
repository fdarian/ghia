---
"@ghia/native": minor
"@ghia/react": minor
"@ghia/solid": minor
---

`<input type="range">` works as in HTML, so the real `@base-ui/react` Slider, whose thumb renders one, runs unchanged. It is a focusable 129 by 16 `inline-block` box with the `slider` role and its value, `min`, `max` and `step` in the accessibility node, and nothing painted in it: a Slider draws its own track and thumb and handles the pointer, and Ghia's range does not drag. `value` (a number or numeric string), `defaultValue`, `min` (0), `max` (100) and `step` (1 or `"any"`) are sanitized as the DOM does (clamped to the limits and snapped to the step from `min`, the midpoint by default); `valueAsNumber`, `min`, `max`, `step`, `stepUp()` and `stepDown()` are properties of an `<input>` element, and a write from code fires nothing. While focused, the arrow keys, Page Up and Down, Home and End change the value unless `keydown` was canceled, firing `input` then `change`; React's `onChange` is the `input` event, a control with a `value` prop goes back to it after the handlers, and the range is in `FormData` under its sanitized value. See `docs/fork/deviations.md`.
