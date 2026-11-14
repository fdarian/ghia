// What ghia-bench's apps/ghia-solid-stack/src/main.tsx renders: the StyleX stylesheet in a <style>, then the app. The bench reads
// the CSS from the file its `vite build` extracted; here the Vite config's StyleX plugin hands the same CSS (useCSSLayers, the
// plugin's lightningcss pass) over as a virtual module.
import type { Message } from "./types"
// App first: StyleX collects a file's rules when the file is transformed, and the virtual module reads them when it is loaded.
import { App } from "./App"
import stylesheet from "virtual:stylex-css"

export function StackApp(props: { messages: Message[] }) {
  return (
    <>
      <style>{stylesheet}</style>
      <App messages={props.messages} />
    </>
  )
}
