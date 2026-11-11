void import("./dynamic-lib.ts").then((lib) => postMessage(`dynamic ${lib.value}`))
