import { render } from '@ghia/react'
import { EditorApp } from './inspector'

render(<EditorApp />, {
  title: 'Lexical on Ghia',
  width: 1000,
  height: 560,
  // An agent launching this to check its own work must not take the keyboard
  // away from whoever is typing. Automation needs no focus.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
