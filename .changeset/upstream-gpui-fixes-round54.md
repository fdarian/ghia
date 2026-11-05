---
'@ghia/native': patch
---

Fixes taken from upstream GPUI. A window with `windowBackground: 'blurred'` is blurred on macOS 27 again. Translucent layers composite with the right alpha over a transparent target: two half-transparent boxes that overlap no longer add up to an opaque one. A cached view follows a change of the opacity it inherits and keeps its subscriptions to the entities it read when it is reused. The cursor no longer reverts when a drag starts, because it is resolved after the listeners of every mouse event. A synthetic drag stops after the button is released. The menu key equivalents of backspace and delete show their glyphs. Two panics are gone, one for a released atlas texture and one for a hit test past the end of a wrapped line. The accessibility adapter is released when its window closes, and the text system no longer leaks.
