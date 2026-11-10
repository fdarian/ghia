---
"@ghia/native": patch
---

A style value that does not parse (`border: 0`, `height: "inherit"`, `width: "var(--x)"`) now drops only that declaration, as in CSS, instead of rejecting the `setStyle` and unmounting the app. A number a property does not take is read as React DOM writes it, and each dropped declaration is logged once.
