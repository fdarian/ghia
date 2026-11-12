/**
 * The part of `react-dom` that code written for the web reaches for, over Ghia's reconciler. A Ghia
 * app has no `react-dom`, and `react()` from `@ghia/react/vite` points the bare `react-dom` import
 * here, so Base UI and the other React libraries run unchanged. Every other export of `react-dom`
 * is absent on purpose: a library that needs one fails at build instead of getting a stub.
 */
import { version } from "react"
import { createPortal } from "./reconciler/portal.js"
import { flushSync } from "./reconciler/reconciler.js"

export { createPortal, flushSync, version }

export default { createPortal, flushSync, version }
