/** The setup file of this package's own vitest suite: see `bindTestRendererScope`. */
import { afterEach, beforeEach } from "vitest"
import { bindTestRendererScope } from "./testing.js"

bindTestRendererScope({ beforeEach, afterEach })
