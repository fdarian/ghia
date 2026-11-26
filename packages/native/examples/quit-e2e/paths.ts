/** Where the e2e keeps its helpers; each case gets a folder of its own for the files the app leaves. */
export const OUT = `${process.env.HOME}/.cache/gpuix-quit-e2e`
export const KILLER_PATH = `${OUT}/quit_killer`
export const HELPER_PATH = `${OUT}/libquit_helper.dylib`

export const CASES = ["apple-event", "apple-event-server", "quit-action", "last-window-close"] as const
export type CaseName = (typeof CASES)[number]

/** Files the app writes into its case folder, each a JSON object with a wall-clock `time` in ms. */
export const READY_FILE = "ready.json"
export const REQUEST_FILE = "request.json"
export const TERMINATED_FILE = "terminated.json"

/** How long the app sits idle, after its window is up, before it is asked to quit. */
export const IDLE_MS = 1500

/** How long the app has to end once asked. */
export const QUIT_LIMIT_MS = 2000
