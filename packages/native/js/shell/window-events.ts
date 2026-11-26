import type { EventPayload } from "../../index.js"
import { createDomEvent, EVENT_PHASE_AT_TARGET, EVENT_PHASE_NONE, reportHandlerErrors } from "../events/dispatch.js"
import { window as ghiaWindow } from "../events/window-target.js"

const NO_ROOT = { eventHandlers: new Map(), elementById: () => undefined }

/** Sends `type` to the listeners of `window`, with `fields` as the event's own members, the way `resize` is sent. */
export function dispatchWindowEvent(type: string, fields: object): void {
  const payload = { elementId: 0, eventType: type, ...fields } as unknown as EventPayload
  const created = createDomEvent(NO_ROOT, payload, [], globalThis)
  const errors: unknown[] = []
  ghiaWindow.run(created.event, created.state, true, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
  ghiaWindow.run(created.event, created.state, false, EVENT_PHASE_AT_TARGET, (error) => errors.push(error))
  created.event.currentTarget = null
  created.event.eventPhase = EVENT_PHASE_NONE
  reportHandlerErrors(NO_ROOT, errors)
}
