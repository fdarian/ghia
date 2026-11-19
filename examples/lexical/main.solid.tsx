import { render } from '@ghia/solid'
import { EditorApp } from './app.solid'

render(() => <EditorApp />, {
  title: 'Lexical on Ghia · Solid',
  width: 900,
  height: 700,
  // An agent launching this to check its own work must not take the keyboard
  // away from whoever is typing. Automation needs no focus.
  focus: process.env.GPUIX_BACKGROUND !== '1',
})
