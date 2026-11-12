import { createTestRoot } from "@ghia/react/testing"
import { useState } from "react"
import * as ReactDOM from "react-dom"
import { createPortal, flushSync } from "react-dom"
import { Layer, flush, members } from "react-dom-lib"

let setCount!: (count: number) => void

function App() {
  const [count, set] = useState(0)
  setCount = set
  return (
    <div style={{ width: 100, height: 40 }}>
      {`count ${count}`}
      {createPortal(<div style={{ width: 40, height: 10 }}>{`own portal ${count}`}</div>, document.body)}
      <Layer label="library portal" />
    </div>
  )
}

/** What a web library sees of `react-dom` in a Ghia app, one fact per line. */
export function run(): string[] {
  const app = createTestRoot()
  const facts: string[] = []
  try {
    app.render(<App />)
    const text = () => app.renderer.getAllText()
    facts.push(`portals ${text().filter((line) => line.includes("portal")).sort().join(" | ")}`)

    setCount(1)
    app.renderer.flush()
    facts.push(`after setState ${text().includes("count 1")}`)
    flushSync(() => setCount(2))
    app.renderer.flush()
    facts.push(`after flushSync ${text().includes("count 2")}`)
    flush(() => setCount(3))
    app.renderer.flush()
    facts.push(`after the library's flushSync ${text().includes("count 3")}`)

    facts.push(`namespace ${Object.keys(ReactDOM).sort().join(",")}`)
    facts.push(`library namespace ${members.namespace.join(",")}`)
    facts.push(`library default ${members.default.join(",")}`)
    facts.push(`version ${members.sameVersion}`)
  } finally {
    app.unmount()
  }
  return facts
}
