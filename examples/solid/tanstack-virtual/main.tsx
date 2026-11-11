import { render } from '@ghia/solid'
import { App } from './App'
import { MeasuredApp } from './MeasuredApp'
import { makeMessages } from './messages'

const messages = makeMessages(10_000)

render(() => (process.env.MEASURED ? <MeasuredApp messages={messages} /> : <App messages={messages} />), {
  title: 'TanStack Virtual',
  width: 420,
  height: 800,
  appearance: 'light',
})
