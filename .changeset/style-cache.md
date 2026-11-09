---
'@ghia/native': patch
---

The step that applies a declared style to a host div is kept per interned style and colour and length context, and the next element with the same style has the result laid over its div: 50 rows built whole cost 5.7% fewer instructions (1000.7k to 943.9k a row), a patched list crossing 2.1% fewer. A style that a state, a transition, a motion, an animation, `var()` or the `rtl` mirror produced is applied each time, as before.
