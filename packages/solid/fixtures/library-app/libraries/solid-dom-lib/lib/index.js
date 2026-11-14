import { template as _$template, insert as _$insert, delegateEvents as _$delegateEvents } from "solid-js/web"

const _tmpl$ = /*#__PURE__*/ _$template(`<button>`)

export function Button(props) {
  const element = _tmpl$()
  _$insert(element, () => props.children)
  return element
}

_$delegateEvents(["click"])
