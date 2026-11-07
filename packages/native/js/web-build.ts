import * as native from "@ghia/native"

/**
 * Whether this runs on the wasm build, in a real browser, rather than on the native
 * addon. The browser entry exports `webBuild`; the addon's loader does not.
 */
export const isWebBuild: boolean = Reflect.get(native, "webBuild") === true
