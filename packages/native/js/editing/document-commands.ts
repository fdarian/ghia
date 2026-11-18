/**
 * Where `document.execCommand` and the `queryCommand*` methods go. They are installed by
 * `clipboard-commands.ts`, which needs `document` and so cannot be imported by the module that
 * defines it.
 */

export interface DocumentCommands {
  exec(name: string): boolean
  supported(name: string): boolean
  enabled(name: string): boolean
}

let installed: DocumentCommands | undefined

export function setDocumentCommands(commands: DocumentCommands): void {
  installed = commands
}

export function documentCommands(): DocumentCommands {
  if (installed === undefined) throw new Error("document.execCommand is not available before the renderer is loaded")
  return installed
}
