import { applyMacCpuThrottleFromEnv, render } from '@ghia/react'
import { ChatApp } from './chat'

applyMacCpuThrottleFromEnv()
render(<ChatApp turnCount={1_000} includeSafeMdx />, {
  title: 'GPUIX Chat · 1,000 messages',
  width: 1180,
  height: 820,
  titlebarTransparent: process.platform !== 'win32',
  windowBackground: 'blurred',
  trafficLightX: 16,
  trafficLightY: 17,
  debugFrameOverlay: 'full',
  // An agent launching this to check its own work must not take the keyboard
  // away from whoever is typing. Automation needs no focus.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
