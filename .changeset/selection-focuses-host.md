---
"@ghia/native": patch
---

Setting the selection inside an editing host that does not hold focus (`setBaseAndExtent`, `collapse`, `addRange`, ...) focuses the host, as Chrome does. Lexical's `editor.focus()` moves focus into an editor this way.
