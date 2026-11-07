---
'@ghia/native': patch
---

A programmatic write to a `<virtual-list>` offset (`scrollTo`, `scrollTop = n`) and a wheel that changes which rows show are drawn by moving the rows that stay, taking out the rows that leave and building only the rows that come in, when the rows that come in have a measured size, where the frame was built whole: the picture, the boxes, what is under a point and where a click goes are those of the frame built whole. `getPatchCounters().scrollPatch` counts them (`membershipFrames`, `rowsBuilt`, `rowsRemoved`) and says what held the others whole (`held["Membership.unmeasured"]`, `Membership.unmeasuredOverdraw`, `Membership.settles`, `Membership.disjoint`, `Membership.noBuilder`). Needs the list scroll patch of the zed submodule.
