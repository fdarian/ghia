---
'@ghia/solid': patch
'@ghia/native': patch
---

Solid no longer queues a `setStyle` or `setCustomProp` for a value the element already has. An effect that ran again and built an equal style object (a row whose style reads `selected`, an `aria-label` and a style in one effect) sent the whole style to native every time: in the bench's mailbox app, 180 identical `setStyle` ops and 27 KB of JSON for a key that changed nothing. The host remembers the JSON it last wrote for each element's style and custom props and writes only what differs from it, so a style object changed in place and passed again is still written, and so is a key order that differs. A prop never written is written, and a new native element starts with nothing written. `@ghia/native/host` exports `SentWrites`.
