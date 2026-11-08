import { applyMacCpuThrottleFromEnv, render } from '@ghia/react'
import { InfiniteChatApp } from './infinite-chat'

applyMacCpuThrottleFromEnv()
render(<InfiniteChatApp />, {
  title: 'GPUIX Infinite History',
  width: 920,
  height: 760,
  titlebarTransparent: true,
  windowBackground: '#1A1A1A',
  debugFrameOverlay: 'full',
  // Agent checks need real GPU paint, not control of the user's keyboard.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
