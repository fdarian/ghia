---
'@ghia/native': patch
---

Lower memory. A CSS length is stored as one term (or a shared array for a mixed-unit `calc()`), so a style takes 6.3 KB instead of 16 KB; a Motion state's tracks are boxed; and an image tile over 512 px gets an atlas texture of its own size. At rest, with the Solid transform cache warm: the ghia-swiftui demo 131 to 116 MB, its Apple Music clone 260 to 211 MB, the fluid-functionalism gallery 195 to 178 MB (measured with a 256 KiB instance buffer start that was reverted afterwards: up to 5 MB less than a build now).
