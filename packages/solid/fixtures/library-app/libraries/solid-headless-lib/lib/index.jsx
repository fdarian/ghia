import { Dynamic, Portal, isServer } from "solid-js/web"
import { createRenderer } from "@ghia/solid"
import { splitProps } from "solid-js"

export const rendersOnGhia = typeof createRenderer === "function" && !isServer

export function Tag(props) {
  const [local, others] = splitProps(props, ["as"])
  return <Dynamic component={local.as} data-lib="tag" {...others} />
}

export function Overlay(props) {
  return (
    <Portal>
      <div data-lib="overlay">{props.children}</div>
    </Portal>
  )
}
