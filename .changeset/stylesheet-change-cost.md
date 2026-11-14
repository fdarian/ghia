---
"@ghia/native": patch
---

A stylesheet change (`insertRule`, `deleteRule`, a `<style>` added, removed or edited) reparses only the rules whose text is new and matches again only the elements a changed rule can reach: `insertRule` of a rule that matches nothing at 10,000 elements costs 1.1M instructions, down from 21M. Restyling many elements no longer clones each style to classify the change: a class toggled on 5,000 elements costs 33.3M instructions with inline styles (was 66.5M) and 44.8M with a sheet (was 78.1M).
