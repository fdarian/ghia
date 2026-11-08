import { useState } from "react"
import { Label } from "./label.tsx"

export function Counter() {
  const [count, setCount] = useState(0)
  return (
    <div style={{ width: 200, height: 50 }} onClick={() => setCount((value) => value + 1)}>
      <Label count={count} />
    </div>
  )
}
