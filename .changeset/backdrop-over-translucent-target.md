---
'@ghia/native': patch
---

A `backdropFilter` blurs the content painted after a `<nativeview>` or `<webview>` that is under it. The filtered backdrop went over the layer above the view, which starts out transparent, instead of replacing what the layer held under the box, so the sharp content showed through the translucent blurred copy and the blur read as nothing. It now replaces it, on a transparent window too.
