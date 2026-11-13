/// GPUIX JSX dev-runtime types: the JSX namespace of jsx-runtime.d.ts, for development builds.
///
/// React 19's `react/jsx-dev-runtime` exports only `jsxDEV`, so the aliases here
/// must match jsx-dev-runtime.js instead of re-exporting `jsx` and `jsxs`.

export { jsxDEV, jsxDEV as jsx, jsxDEV as jsxs, Fragment } from "react/jsx-dev-runtime"

/** The same JSX types as `jsx-runtime`. */
export type { JSX } from "./jsx-runtime.js"
