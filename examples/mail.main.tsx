import { applyMacCpuThrottleFromEnv, render } from '@ghia/react'
import { MailApp } from './mail'

applyMacCpuThrottleFromEnv()
render(<MailApp />, {
  title: 'Mail',
  appName: 'Mail',
  width: 1280,
  height: 860,
  titlebarTransparent: true,
  windowBackground: '#141416',
  trafficLightX: 16,
  trafficLightY: 17,
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
