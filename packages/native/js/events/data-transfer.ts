import {
  DataTransfer,
  dataTransferControl,
  type DataTransferControl,
  type DataTransferMode,
} from "../dom/data-transfer.js"
import type { HostDataTransfer, HostDropEffect, HostEffectAllowed, HostFile } from "./types.js"

export type { DataTransferMode }

export interface DataTransferSession {
  readonly dataTransfer: HostDataTransfer
  /** The drag dispatcher sets this before each event; handlers cannot. */
  mode: DataTransferMode
}

/** The drop effect a target gets before its handler picks one. */
export function defaultDropEffect(effectAllowed: HostEffectAllowed): HostDropEffect {
  switch (effectAllowed) {
    case "none":
      return "none"
    case "link":
    case "linkMove":
      return "link"
    case "move":
      return "move"
    default:
      return "copy"
  }
}

/** Whether a source that allowed `effectAllowed` lets a target choose `dropEffect`. */
export function allowsDropEffect(
  effectAllowed: HostEffectAllowed,
  dropEffect: HostDropEffect
): boolean {
  if (dropEffect === "none") return true
  if (effectAllowed === "all" || effectAllowed === "uninitialized") return true
  return effectAllowed.toLowerCase().includes(dropEffect)
}

/**
 * The `DataTransfer` of one drag. A drag of an element fills it in `dragstart`; a drag of files
 * from the OS arrives with `files` and nothing else for a handler to add. `setDragImage` is
 * accepted and ignored: there is no drag image.
 */
export function createDataTransfer(files: readonly HostFile[] = []): DataTransferSession {
  const dataTransfer = new DataTransfer()
  const control: DataTransferControl = dataTransferControl(dataTransfer)
  for (const file of files) control.addFile(file)
  control.effectAllowed = files.length > 0 ? "all" : "uninitialized"
  control.mode = "protected"
  return {
    // Its files are the `HostFile`s added above.
    dataTransfer: dataTransfer as unknown as HostDataTransfer,
    get mode() {
      return control.mode
    },
    set mode(value) {
      control.mode = value
    },
  }
}
