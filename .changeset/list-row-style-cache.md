---
'@ghia/native': patch
---

The root of a virtual-list row hits the style cache: that a row does not lift is a build input said after its style (`stacking::absorb_lift`), not a flag on a clone of its `StyleDesc`, so the row's style is the element's own `Arc` and no `StyleDesc` is cloned per row. 50 rows built whole: `styleDescClones` 99 to 0, `styleAppliesReplayed` 414 to 463.
