---
'@ghia/native': patch
---

The hover of an element is classified as paint-only when its `hover`, `groupHover` or `hasHover` style changes nothing but colours, an opacity that stays a layer, or the colour of a shadow or a border. Nothing is drawn differently yet: the classification (`events/hover_paint.rs`) is what the hover patch frames that follow are built on.
