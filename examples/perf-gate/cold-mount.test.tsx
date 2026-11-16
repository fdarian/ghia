import { defineGate } from './gate'
import { coldMount, measure } from './scenarios'

// Its own file so that vitest gives it a process of its own: the window it measures is the first one that process builds,
// which is what an app's mount pays (perf-gate.test.tsx warms the process up first). Measured once, since only one window
// per process is the first.
defineGate('cold-mount', [coldMount], measure)
