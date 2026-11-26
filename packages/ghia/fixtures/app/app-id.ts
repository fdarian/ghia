import "./app-id-reader.ts"
// The slot is read by the runtime, so a plain script can say what it saw.
console.log(`APP_ID ${String(Reflect.get(globalThis, Symbol.for("@ghia/native/app-id")))}`)
if (process.env.APP_ID_FIXTURE_WRITE === "1") localStorage.setItem("greeting", "hello")
