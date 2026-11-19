---
"@ghia/native": minor
"@ghia/react": patch
"@ghia/solid": patch
---

`Range`, `StaticRange` and `AbstractRange` exist, with `document.createRange()`. A `Range` is live: a tree change, including a React or Solid insert, removal or text update, and a data change move its boundary points as the DOM standard says. `CharacterData` has `substringData`, `appendData`, `insertData`, `deleteData` and `replaceData`, `Text` has `splitText` and `wholeText`, and `document.hasFocus()` answers.
