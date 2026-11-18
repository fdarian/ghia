import { render } from '@ghia/react'
import { EditorApp } from './app.react'

render(<EditorApp />, {
  title: 'Lexical on Ghia · React',
  width: 900,
  height: 700,
  // An agent launching this to check its own work must not take the keyboard
  // away from whoever is typing. Automation needs no focus.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
