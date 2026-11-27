/**
 * Where `document.execCommand` and the `queryCommand*` methods go. They are installed by
 * `clipboard-commands.ts`, which needs the document class and so cannot be imported by the module that
 * defines it. Each takes the document the call was made on, whose window the command runs in.
 */

import type { GpuixDocument } from "../events/window-target.js"

export interface DocumentCommands {
  exec(document: GpuixDocument, name: string): boolean
  supported(name: string): boolean
  enabled(document: GpuixDocument, name: string): boolean
}

let installed: DocumentCommands | undefined

export function setDocumentCommands(commands: DocumentCommands): void {
  installed = commands
}

export function documentCommands(): DocumentCommands {
  if (installed === undefined) throw new Error("document.execCommand is not available before the renderer is loaded")
  return installed
}
