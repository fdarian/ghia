---
'@ghia/native': patch
---

A blurred `box-shadow` on a box under an `opacity`, `filter` or `mask` ancestor is no longer cut off at a hard rectangle while the ancestor animates or holds its effect. The group's bounds and the draw order now count the whole blur: an outer shadow reaches three times its blur radius past its box, as it is drawn. The shadow paints as the same shadow with no ancestor effect.
