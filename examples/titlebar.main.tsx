import { render } from '@ghia/react'
import { TitlebarApp } from './titlebar'

render(<TitlebarApp />, {
  title: 'GPUIX Titlebar',
  appName: 'GPUIX Titlebar',
  width: 640,
  height: 360,
  titlebarTransparent: true,
  trafficLightX: 18,
  trafficLightY: 13,
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
