---
"@ghia/native": minor
---

A click on an `<a href>` to another origin (`http:`, `https:`, `mailto:` and `tel:`) opens it with the system's default handler, through a new `openUrl` method of the renderer; a same-origin path or query that no router took is still only warned about, and `javascript:` does nothing. A click on a link is now delivered to the document even when nothing listens to `click`. The test renderer records the requests (`openedUrls()`) and opens nothing.
