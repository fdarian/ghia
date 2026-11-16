---
"@ghia/native": patch
---

Stylesheets support the form and tree state pseudo-classes `:disabled`, `:enabled`, `:checked`, `:indeterminate`, `:required`, `:optional`, `:read-only`, `:read-write`, `:any-link` and `:link`, in any compound and inside `:is()`, `:where()` and `:not()`. Before, a rule that used one was dropped. A prop or a click that changes one of them restyles only the elements that read it (toggling `disabled` on one of a thousand buttons matches that button again; checking a radio matches it and the radio it unchecked), and a sheet that uses none marks nothing extra. `:placeholder-shown`, `:invalid`, `:valid`, `:default`, `:open`, `:autofill` and the range pseudo-classes are still not supported.
