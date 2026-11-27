/**
 * Vitest setup file (`setupFiles: ["@ghia/native/testing-setup"]`): closes the test windows a test
 * left open when the test ends. The test renderer opens any number of windows on one app, and
 * none closes another, so a suite that makes a window per test and never disposes it would
 * otherwise keep every one of them. A window made in a `beforeAll` or at module level outlives
 * the tests and stays.
 */
import { afterEach, beforeEach } from "vitest"
import { startTestRendererScope } from "./testing.js"

let endScope: (() => void) | undefined

beforeEach(() => {
  endScope = startTestRendererScope()
})

afterEach(() => {
  endScope?.()
  endScope = undefined
})
