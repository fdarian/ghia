export { HELPER_PATH, OUT } from "../quit-e2e/paths"

/** What each case does with the two windows, after both are up and checked. */
export const CASES = ["close-second", "close-first", "close-button", "close-all", "quit", "window-open"] as const
export type CaseName = (typeof CASES)[number]

/** Files the app writes into its case folder, each a JSON object with a wall-clock `time` in ms. */
export const READY_FILE = "ready.json"
export const REPORT_FILE = "report.json"
export const TERMINATED_FILE = "terminated.json"

/** How long the app has to end once the last window is closed or a quit is asked for. */
export const END_LIMIT_MS = 1500

/** What the app found out about its windows; the runner judges it. */
export interface Report {
  /** Visible windows once both were up. */
  windowsAtStart: number
  /** What a key handler of the second window found calling the first renderer: "ok", or what went wrong. */
  crossWindowCall: string
  alphaHasOwnTree: boolean
  betaHasOwnTree: boolean
  boundsDiffer: boolean
  /** Which renderer's window went in the close case ("close-button" closes whichever AppKit finds first).
   *  */
  closed: "alpha" | "beta" | null
  /** Visible windows after the first one was closed alone, and whether the other renderer saw it. */
  windowsAfterClose: number
  closedRendererSawIt: boolean
  survivorStillOpen: boolean
  /** The survivor drew a frame for a change made after the other window closed (not asked of a window the
   *  system does not show: its display link gets no frames). */
  survivorRedrew: boolean
  survivorWasShown: boolean
  survivorShowsUpdate: boolean
  /** How many times each renderer's `onWindowClosed` ran. */
  windowClosedCalls: { alpha: number; beta: number }
  /** What `window.open` did, for the "window-open" case: null in the others. */
  windowOpen: WindowOpenReport | null
}

/** What the app found out about a window it opened with `window.open("", "gamma", features)`. */
export interface WindowOpenReport {
  /** Visible windows with the opened one up. */
  windowsWhileOpen: number
  /** The opened window's size and place, from the features, as `innerWidth`, `innerHeight`, `screenX` and `screenY` say. */
  size: [number, number]
  position: [number, number]
  devicePixelRatioMatchesNative: boolean
  openerIsTheFirstWindow: boolean
  /** The opened window holds its own tree (found through the automation tree of its renderer) and not the others'. */
  hasOwnTree: boolean
  ownBodyHasContent: boolean
  /** The same name finds the window again. */
  reusedByName: boolean
  /** `close()` fired beforeunload, pagehide and unload, in that order, then `closed` was true. */
  closeEvents: string[]
  closedAfterClose: boolean
  /** What `window.open` did called from a key handler of another window, inside native's dispatch: "ok", or what went wrong. */
  openedFromHandler: string
  windowsAfterClose: number
  /** The first window drew a change made after the opened window closed. */
  openerStillShowsUpdate: boolean
}
