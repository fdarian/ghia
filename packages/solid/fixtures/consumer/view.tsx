import { createSignal } from "solid-js"

export function createView() {
  const [value, setValue] = createSignal(1)
  return {
    view: () => <div>consumer {value()}</div>,
    update: () => setValue(2),
  }
}
