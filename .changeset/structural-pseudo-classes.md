---
"@ghia/native": patch
---

Stylesheets support the structural pseudo-classes: `:first-child`, `:last-child`, `:only-child`, `:nth-child(An+B)`, `:nth-last-child(An+B)`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type(An+B)`, `:nth-last-of-type(An+B)` and `:empty`, in any compound and inside `:is()`, `:where()` and `:not()`. Before, a rule that used one was dropped. A child that comes, goes or moves restyles only the siblings whose position it changes (the two neighbours for `:first-child` and `:last-child`, the siblings after it for `:nth-child()`, before it for `:nth-last-child()`, the parent for `:empty`), and a sheet that uses none of them marks nothing extra. `:nth-child(An+B of S)` is still not supported.
