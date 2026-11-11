import type { NativeRenderer } from "./host.js"
import { namedError } from "./named-error.js"

/** What an adapter hands `requestFormSubmit` for one `<form>`. */
export interface FormHost {
  id: number
  nativeRenderer: NativeRenderer
  /** Apply queued mutations, so the form and its controls exist natively. */
  flushMutations(): void
}

/** What native refuses with, before it is the error the DOM throws. */
const TYPE_ERROR_PREFIX = "TypeError: "
const NOT_FOUND_ERROR_PREFIX = "NotFoundError: "

function submitterId(submitter: unknown): number | undefined {
  if (submitter === undefined || submitter === null) return undefined
  const id = typeof submitter === "object" ? (submitter as { id?: unknown }).id : undefined
  if (typeof id !== "number") {
    throw new TypeError("Failed to execute 'requestSubmit' on 'HTMLFormElement': parameter 1 is not of type 'HTMLElement'")
  }
  return id
}

function refusal(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  if (error.message.startsWith(TYPE_ERROR_PREFIX)) {
    return new TypeError(error.message.slice(TYPE_ERROR_PREFIX.length))
  }
  if (error.message.startsWith(NOT_FOUND_ERROR_PREFIX)) {
    return namedError("NotFoundError", error.message.slice(NOT_FOUND_ERROR_PREFIX.length))
  }
  return error
}

/** `submitter` is the element `requestSubmit(submitter)` was given: a submit `<button>` of this form. */
export function requestFormSubmit(host: FormHost, submitter?: unknown): void {
  const renderer = host.nativeRenderer
  if (!renderer.requestSubmit) {
    throw new Error("This GPUIX renderer does not support requestSubmit()")
  }
  const submitterElementId = submitterId(submitter)
  host.flushMutations()
  try {
    renderer.requestSubmit(host.id, submitterElementId)
  } catch (error) {
    throw refusal(error)
  }
}
