// A web library as installed from npm: plain ESM that imports `react-dom` the way Base UI does.
import * as React from "react"
import * as ReactDOM from "react-dom"
import DefaultReactDOM from "react-dom"

export function Layer(props) {
  return ReactDOM.createPortal(React.createElement("div", { style: { width: 40, height: 10 } }, props.label), document.body)
}

export const flush = ReactDOM.flushSync

export const members = {
  namespace: Object.keys(ReactDOM).sort(),
  default: Object.keys(DefaultReactDOM).sort(),
  sameVersion: ReactDOM.version === DefaultReactDOM.version,
}
