---
"@ghia/native": patch
---

Scrolling builds fewer rows that hold a `position: relative` or `absolute` box. A row that hands such a box to the stacking context around it was built again on every scroll frame; its recording now carries the box (its paint and its hitboxes are recorded with the row and put where the scroll moves it), so the row is moved. A row whose box is cut differently where the scroll puts it (a rounded clip inside the box) is built.
