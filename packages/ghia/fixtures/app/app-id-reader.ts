// An import of the entry runs before the entry's own body: a library may read localStorage this early.
console.log(`APP_ID_AT_IMPORT ${String(Reflect.get(globalThis, Symbol.for("@ghia/native/app-id")))}`)
