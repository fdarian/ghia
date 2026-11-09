---
'@ghia/native': patch
'@ghia/solid': patch
'@ghia/react': patch
---

The mutation batch is one binary byte array instead of JSON text. `createMutationQueue` writes each op as it is enqueued through `WireWriter` (`@ghia/native`, `js/wire.ts`) into reused buffers, with no tuple per op and no `JSON.stringify` of the batch, and `applyBatch(bytes: Uint8Array)` on the live, test and wasm renderers decodes it in place (`batch::wire`), so the napi call transcodes no string and the decoder allocates nothing per op beyond what it keeps. The format is specified in `docs/reference.md` ("Wire format"). **Breaking for anything that calls `applyBatch` itself**: it takes the bytes, not a JSON string; tests that built or parsed a batch use `encodeWireBatchForTest` and `decodeWireBatchForTest` from `@ghia/native/testing`. `MutationRenderer.setStyle` takes the style's JSON text as an optional third argument, which Solid passes from the text its write comparison already made, so a written style is stringified once. A failed batch is put back in front of what was enqueued since, and a style native rejects is cut out of the batch by its byte range, as before.
