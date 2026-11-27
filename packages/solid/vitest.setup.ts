import { bindTestRendererScope } from '@ghia/native/testing'
import { afterEach, beforeEach } from 'vitest'

// Closes the test windows a test left open when it ends: see `bindTestRendererScope`.
bindTestRendererScope({ beforeEach, afterEach })
