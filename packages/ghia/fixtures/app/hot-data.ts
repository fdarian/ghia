// A module's `import.meta.hot.data` survives the runner's own full reload, and not `clearCache()`.
const data = import.meta.hot!.data
data.runs = (data.runs ?? 0) + 1
console.log(`HOT_RUN ${data.runs} version one`)
setInterval(() => {}, 1000)
