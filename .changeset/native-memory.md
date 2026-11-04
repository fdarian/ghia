---
'@ghia/native': patch
---

Lower memory. A CSS length is stored as one term (or a shared array for a mixed-unit `calc()`), so a style takes 6.3 KB instead of 16 KB; a Motion state's tracks are boxed; a decoded single-frame image keeps its pixels only in the GPU atlas once uploaded (read back on demand); an image tile over 512 px gets an atlas texture of its own size; and the instance buffers start at 256 KiB. At rest, with the Solid transform cache warm: the ghia-swiftui demo 131 to 116 MB, its Apple Music clone 260 to 211 MB, the fluid-functionalism gallery 195 to 178 MB.
