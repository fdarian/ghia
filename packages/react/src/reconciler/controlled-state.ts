import type { EventPayload } from "@ghia/native"
import type { Container } from "../types/host.js"

/**
 * React DOM's `restoreControlledState`: after the handlers of a change event ran and the update
 * they made was flushed, the control shows the `checked` or `value` prop that was committed, so a
 * handler that does not take the change leaves the control as it was. Native never does this on its
 * own, which is why Solid, which does not do it either, keeps the user's change.
 *
 * Ghia's `onChange` of a checkbox or radio is the `change` event, and a range's is `input`, as
 * `fieldHandlers` wires them. A text control is not restored: native keeps the text a user typed.
 */
export function restoreControlledState(container: Container, event: EventPayload): void {
  const id = event.path?.[0] ?? event.target
  if (id === undefined || id === null) return
  const instance = container.instances.get(id)
  if (instance === undefined || instance.elementType !== "input") return
  const type = (instance.props as { type?: unknown }).type
  const isChoice = type === "checkbox" || type === "radio"
  if (isChoice ? event.eventType !== "change" : type !== "range" || event.eventType !== "input") return
  // The commit the handlers made sends at its end; what a handler wrote since is sent here.
  container.renderer.flushMutations()
  container.nativeRenderer.restoreControlledState?.(id)
}
