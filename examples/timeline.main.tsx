import { applyMacCpuThrottleFromEnv, render } from '@ghia/react'
import { TimelineApp } from './timeline'

applyMacCpuThrottleFromEnv()
render(<TimelineApp />, {
  title: 'GPUIX · Timeline',
  width: 1280,
  height: 800,
  debugFrameOverlay: 'full',
  // Agent checks need real GPU paint, not control of the user's keyboard.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
