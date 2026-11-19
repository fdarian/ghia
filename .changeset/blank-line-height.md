---
"@ghia/native": patch
---

A block whose only content is a line break (`<div><br></div>`, `<p><br></p>`, or a lone `"\n"` under `white-space: pre`) is one line tall, as in Chrome, and not zero. `a<br>` stays one line and `<br><br>` is two.
