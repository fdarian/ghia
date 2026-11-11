# Build native GPUI desktop apps with Solid 1

**`@ghia/solid`** paints a Solid 1 tree with GPUI. Same host elements, styles, events, and native addon as React. The adapter is Solid. The window is not a web view.

```text
  vite.config.mts        vite-plugin-solid          @ghia/native
  ghia() + solid() ────► universal compiler ───────► host mutations ──► GPUI ──► GPU
       │                        │
       ▼                        ▼
  ghia dev / build      @ghia/solid renderer
  app.tsx               render(() => <App />)
```

> **Note.** Host elements, styles, events, virtual lists, and native text are the same as React. This page covers the **Solid adapter**. See [reference.md](reference.md) for the shared Ghia surface. Solid and React both run on Vite through the `ghia` command ([React vs Solid](#react-vs-solid)).

## Install

Pin **`@ghia/solid`**, **`@ghia/native`** and **`ghia`** to the same exact version. Ghia is still pre-1.0. Upgrade them together.

```bash
pnpm add --save-exact @ghia/solid @ghia/native ghia solid-js
pnpm add --save-dev vite
```

The peer ranges are **`solid-js` `>=1.9 <2`** and **`vite` `^8`**.

Install **`@ghia/native`** yourself, although `@ghia/solid` depends on it. The `ghia()` plugin makes `import "@ghia/native/dom-globals"` the first line of your entry, and that import stays outside the bundle (the native addon has to load as a real module). It is resolved from your app, so a package that is not one of your own dependencies is not found under pnpm.

### TypeScript

**`jsx: "preserve"`** and **`jsxImportSource: "@ghia/solid"`** are required. Without them TypeScript uses DOM types, so `<virtual-list>`, `<markdown>`, and `style.hover` fail to typecheck.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "@ghia/solid",
    "types": ["vite/client"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`vite/client` types `?raw` imports and `import.meta.hot`.

### Vite config

```ts
// vite.config.mts
import { defineConfig } from 'vite'
import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'

export default defineConfig({
  plugins: [ghia({ entry: 'main.tsx' }), solid()],
})
```

Name the file `vite.config.mts` unless your `package.json` has `"type": "module"`.

**`ghia({ entry })`** sets up the environment the app runs in. The UI process behaves like a browser page: it resolves packages with their `browser` export conditions and has `window` and `document`, but it runs inside Bun next to the native addon. The plugin bundles every dependency into the app except `@ghia/native`. `entry` is the file that calls `render()`, relative to the project root. It is the single input of `ghia build`.

**`solid()`** compiles JSX for Solid's universal renderer with `@ghia/solid` as its module, resolves one `solid-js` for the app and the adapter, and adds solid-refresh in `ghia dev`. The app resolves Solid's client builds, so `isServer` from `solid-js/web` is `false` and libraries that branch on it, such as `@tanstack/solid-query`, run their client code.

The design behind these choices is in [web-renderer.md](fork/web-renderer.md).

## First app

End the entry with **`render()`**. That call creates the window, mounts Solid, and starts the frame loop.

```tsx
// main.tsx
import { createSignal } from 'solid-js'
import { render } from '@ghia/solid'

function App() {
  const [count, setCount] = createSignal(0)
  return (
    <div style={{ padding: 24, backgroundColor: '#1a1a1a', height: '100%' }}>
      <div
        onClick={() => setCount((value) => value + 1)}
        style={{
          padding: 12,
          borderRadius: 8,
          cursor: 'pointer',
          backgroundColor: '#232323',
          hover: { backgroundColor: '#2c2c2c' },
        }}
      >
        <div style={{ color: '#e2e2e2' }}>Count: {count()}</div>
      </div>
    </div>
  )
}

render(() => <App />, { title: 'Solid Ghia', width: 800, height: 600 })
```

Set a `color` for text on a dark surface. `color` is inherited: put it on the element that holds the text or on an ancestor. Text with no color paints black and disappears on a dark surface.

Read signals with **`count()`**. `render` takes a function, not a pre-built element: `render(() => <App />)`.

## Run

```bash
ghia dev
```

`ghia dev` starts a Vite dev server and imports the entry in the same process, so the window opens from the CLI's own process. Pass `--config <file>` for a config with another name. The `ghia` command runs under Bun and refuses to start under Node. Put it in your scripts:

```json
{
  "scripts": {
    "dev": "ghia dev",
    "build": "ghia build"
  }
}
```

Do **not** call `createRenderer()` or `init()` in the entry. A full reload imports the entry again, and a second `init()` would open a second window. `render()` is idempotent: the first call owns the window, later calls only remount.

### Hot reload

An edit to a component module is an HMR update (solid-refresh): the edited component runs again and the window, the rest of the tree and the module state of the other files stay. An edit to a module a component imports updates the components that import it.

> **Warning.** Local signal state in the components that update is reset. It is not React Fast Refresh with preserved state: `createSignal` inside an edited component starts again at its initial value.

An edit that no component accepts is a full reload: the runner's module cache and its HMR data are cleared and the entry runs again, so `render()` remounts the tree on the same window and all state is lost. That is the entry itself and any module reached only from the entry. Component edits after a reload are HMR updates again, and `render()` uses the options of its latest call, such as `onUncaughtError`.

Not covered by reload:

- The native addon. Rebuild it and restart `ghia dev`.
- `vite.config`. Restart `ghia dev`.
- Anything under `node_modules`: solid-refresh only wraps your own files.

React runs under the same command, with React Fast Refresh in place of solid-refresh ([reference.md](reference.md#hot-reload)).

### Production build

```bash
ghia build
./dist/app
```

`ghia build` bundles the app and then compiles the bundle into `dist/app`, one executable. It embeds Bun and the native addon, so it runs on a machine with no Bun, no `node_modules` and no `@ghia/native` installed. It is about 128 MB, and the addon is 38 MB of that. With a [server Worker](#server-code) the compile carries the Worker too.

`dist/main.js` (and `dist/server.js`) are written before the compile. They run with plain `bun` when `node_modules/@ghia/native` is resolvable from `dist/`.

- `ghia build --no-compile` stops after the bundle and writes no binary.
- `ghia({ entry, compile: { outfile: 'out/tool' } })` moves the binary. The path is relative to the project root, and the default is `app` inside the build's output directory.
- `build({ compile: false })` is the programmatic form of `--no-compile`.

The binary ignores a `bunfig.toml` (a test preload, say) and a `.env` in whichever directory it is launched from.

#### App Workers

A Worker your app starts with `new Worker(new URL('./raster.ts', import.meta.url))` works in the built app and the compiled binary with no configuration. The build finds that pattern, in the UI code and in the server code, when the URL is a relative string literal (a pattern inside a comment or a string does not count). Each Worker file is bundled as a build of its own, in the environment that starts it, and written next to `main.js` as `dist/raster-<hash>.worker.js`; the URL in the output points at it, and the compile carries the file. Nothing is shared with `main.js`, so a module that the app and a Worker both import runs again in each, the way it would in a browser, and `@ghia/native/dom-globals` runs only before the app. The hash is 8 hex digits of the environment and the file's path relative to the project root, so two Workers with the same file name, or one file started from the UI and from the server code, never collide. The options argument (`{ type: 'module' }`) is left as written. A Worker that starts another Worker is found in turn, and a Worker that starts its own file (with a `name` option to tell the copies apart, say) is a Worker of one file. With `build.sourcemap: true`, each Worker gets its own `.map` and its `sourceMappingURL` names it; with `'inline'` the map stays inline in the Worker and no `.map` is written. Inside a Worker build, a plugin's `configResolved` sees the top-level `build` config (`ssr` false, no input), because the Worker builds share one resolved config.

Each Worker is a build of its own, so a plugin's build hooks (`buildStart`, `generateBundle`, `closeBundle`) run once more for every Worker, and the Vite config file is evaluated again for it.

A URL that is not a relative literal (a variable, a template with `${}`, a package specifier) is not found, and the Worker is not in the binary. A Worker started inside a dependency of the server code is not found either, because server-side dependencies in `node_modules` are not bundled; list the package in `resolve.noExternal` to bundle it. A Worker file that does not resolve fails the build when the call is in your code and warns when it is in `node_modules`, leaving the call as written.

A Worker started from the UI code is bundled with the same browser export conditions as the UI, so `solid-js/web`'s `isServer` is `false` there, and it has no `window` or `document`. A Worker started from the server code resolves as the server does.

`ghia dev` needs none of this: the UI and the server code run through Vite's module runner, whose `import.meta.url` is the real file, so Bun starts the Worker from the `.ts` source. Bun resolves that file's imports itself, so Vite's aliases, `define`, `import.meta.env`, JSX plugin and the `browser` conditions do not apply to it, and editing it does not reload the server; restart `ghia dev` to pick the edit up. `ghia build` bundles the Worker in its environment, so a UI Worker can resolve a different build of a package in dev than in the build (`isServer` from `solid-js/web` is the example).

The compile rewrites `@ghia/native`'s loader on the fly, because Bun's bundler embeds an addon only for a plain `require('./x.node')` and the generated loader gets its `require` from `createRequire`. It fails the build with a clear error if that loader changes shape.

### Gotchas

- **Import text with `?raw`.** Vite ignores `with { type: 'text' }`. Write `import icon from './icon.svg?raw'` to get the file as a string.
- **`Bun.main` is the `ghia` CLI under `ghia dev`.** A guard such as `if (Bun.main === import.meta.path) render(...)` never passes. Call `render()` at the top level of the entry.
- **`NAPI_RS_NATIVE_LIBRARY_PATH` breaks `ghia`.** It replaces every napi-rs binding in the process, and Vite's rolldown is one of them ([testing.md](fork/testing.md#test-commands)).

A worked chat lives in `examples/solid/chat.tsx`. Run it with `cd examples && bun run chat-solid`.

## Server code

The UI process draws frames and handles input. Code that blocks it, such as a database call, a file scan or a long computation, stalls the window. Put that code in a Bun Worker and call it over RPC, the way a page calls its backend. `ghia({ entry, server })` starts the Worker, connects it to the UI with a `MessagePort`, and reloads it when you edit server code. The RPC library is yours; the example uses [oRPC](https://orpc.dev) and its MessagePort adapter.

### Why a Worker

A spike on 2026-11-06 called an oRPC router from a plain Bun process in three ways (Bun 1.4.4, oRPC 1.16.2, median of five runs, no live window):

| | called in the UI process | Worker | separate process |
| --- | --- | --- | --- |
| Startup to the first reply | 2.4 ms | 7.4 ms | 23.7 ms |
| Memory added | 0.3 MB | 8.0 MB, inside the UI process | 22.2 MB idle, in its own process |
| 1 MB round trip, p50 | no RPC | 0.62 ms | 3.06 ms |
| UI timer lag during a 500 ms server task | 499 ms | 0.3 ms | 1.0 ms |

A Worker keeps the UI responsive during long server work for 7 ms of startup. It shares the UI's process, so a native crash or an out-of-memory in server code takes the window down with it. A separate process isolates crashes, at about 24 ms of startup and 22 MB idle; Ghia does not start or reload one for you.

### Set it up

```text
vite.config.mts
src/
  main.tsx      UI entry
  server.ts     server entry
  router.ts     oRPC router, shared by both sides
  env.d.ts      /// <reference types="ghia/client" />
```

```ts
// vite.config.mts
import { defineConfig } from 'vite'
import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'

export default defineConfig({
  plugins: [ghia({ entry: 'src/main.tsx', server: 'src/server.ts' }), solid()],
})
```

`server` is the server entry, relative to the project root. It defines a second Vite environment, `server`, which resolves as Bun does: packages load natively from `node_modules`, with no browser conditions and no `window`.

**The server entry** default-exports `serve(port: MessagePort): () => void`. It wires an RPC handler to the port and returns a function that detaches it. `ghia dev` calls that function before it runs `serve` again.

```ts
// src/router.ts
import { os, type } from '@orpc/server'

let count = 0

export const router = {
  count: os.handler(() => count),
  increment: os.input(type<{ by: number }>()).handler(({ input }) => {
    count += input.by
    return count
  }),
}

export type Router = typeof router
```

```ts
// src/server.ts
import { RPCHandler } from '@orpc/server/message-port'
import { router } from './router.ts'

export default function serve(port: MessagePort): () => void {
  // upgrade() returns nothing and never removes its listeners. ghia dev calls serve() again on the
  // same port after an edit, so without the signal the old handler would answer next to the new one.
  const listeners = new AbortController()
  new RPCHandler(router).upgrade({
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
      port.addEventListener(type, listener, { signal: listeners.signal }),
    postMessage: (message: unknown) => port.postMessage(message),
  })
  return () => listeners.abort()
}
```

**The UI** imports `serverPort` from `virtual:ghia/server`: its end of the channel to `serve`. `ghia/client` declares the module, so reference it once in a `.d.ts` (`env.d.ts` above).

```tsx
// src/main.tsx
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/message-port'
import type { RouterClient } from '@orpc/server'
import { render } from '@ghia/solid'
import { createResource } from 'solid-js'
import { serverPort } from 'virtual:ghia/server'
import type { Router } from './router.ts'

const client: RouterClient<Router> = createORPCClient(new RPCLink({ port: serverPort }))

function App() {
  const [count, { mutate }] = createResource(() => client.count())
  return (
    <div style={{ padding: 24, height: '100%', backgroundColor: '#1a1a1a' }}>
      <div
        onClick={async () => mutate(await client.increment({ by: 1 }))}
        style={{ padding: 12, borderRadius: 8, cursor: 'pointer', backgroundColor: '#232323' }}
      >
        <div style={{ color: '#e2e2e2' }}>Server count: {count()}</div>
      </div>
    </div>
  )
}

render(() => <App />, { title: 'Notes', width: 480, height: 240 })
```

Import the router into the UI as a type only. A value import would pull the server code and its dependencies into the UI bundle. Importing `virtual:ghia/server` without the `server` option fails with an error that names the option.

`@orpc/client` and `@orpc/server` go in `dependencies`. The server bundle leaves them outside, so they have to be installed where `dist/server.js` runs.

### Dev and build

`ghia dev` runs the server entry in the Worker through Vite's module runner. When you edit a module the server imports, the Worker calls the function `serve` returned, imports the entry again and calls `serve(port)` on the **same port**. The UI keeps `serverPort` and its client. Module state on the server starts over: `count` above returns to 0.

`ghia build` writes `dist/main.js` and `dist/server.js` (and a `dist/<name>-<hash>.worker.js` for each [app Worker](#app-workers)). The built UI creates its Worker with `new Worker(new URL('./server.js', import.meta.url))`, so the two files stay together. `bun dist/main.js` starts both. The compiled `dist/app` carries both, and a Worker that fails to start ends the app with the Worker's error instead of leaving the UI waiting.

### What dev does not cover

- **A call in flight during a server reload may never be answered.** The old handler is detached before the new one attaches. Ask again from the UI.
- **A full reload of the UI runs the entry again on the same `serverPort`.** Listeners the old run added to the port stay, so an `RPCLink` created at the top level of the entry exists once per reload.
- **Editing `vite.config` needs a restart** of `ghia dev`, with or without a server.

## Package exports

| Import                         | What it is                                           |
| ------------------------------ | ---------------------------------------------------- |
| `@ghia/solid`                 | Renderer, primitives, motion, controls, host types   |
| `@ghia/solid/jsx-runtime`     | `jsx`, `jsxs`, `Fragment`. Used by `jsxImportSource` |
| `@ghia/solid/jsx-dev-runtime` | `jsxDEV`, `Fragment`                                 |
| `@ghia/solid/vite`            | `solid()`, the Vite plugin for JSX and solid-refresh |
| `@ghia/solid/testing`         | `createTestRoot`, `TestRenderer`                     |
| `@ghia/solid/automation`      | `launch`, `connectTest`                              |
| `@ghia/solid/select`          | Select primitives                                    |
| `@ghia/solid/combobox`        | Combobox primitives                                  |
| `@ghia/solid/tooltip`         | Tooltip primitives                                   |
| `@ghia/solid/floating`        | `FloatingLayer`, `renderSlot`                        |

There is no **`./cpu-throttle`**. Testing and automation are subpaths only.

`ghia` exports **`ghia()`**, the programmatic **`dev(options)`** and **`build(options)`** (options `configFile` and `root`; `dev()` resolves to a handle with `close()`), and ships the `ghia` command, a thin shell over those two. `ghia/client` declares `virtual:ghia/server`.

## `render()`

```ts
function render(code: () => JSX.Element, options?: RenderOptions): Root
function createRenderer(onEvent?: (event: EventPayload) => void): GpuixRenderer
function resetRender(): void
```

```ts
interface RenderOptions extends WindowOptions, RootEventHandlers {
  renderer?: NativeRenderer
  debugFrameOverlay?: 'hidden' | 'minimal' | 'full'
}
```

| Option                            | Purpose                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `title`                           | Window title                                               |
| `width` / `height`                | Window size                                                |
| `titlebarTransparent`             | Hide the native titlebar                                   |
| `windowBackground`                | `"opaque"`, `"transparent"`, `"blurred"`                   |
| `appearance`                      | `"system"` (default), `"light"`, `"dark"`                  |
| `trafficLightX` / `trafficLightY` | Traffic-light origin                                       |
| `appName`                         | Name inside macOS Hide and Quit items                      |
| `focus`                           | `false` opens behind the active app                        |
| `show`                            | `false` opens hidden. Call `activateWindow()` to reveal it |
| `fonts`                           | Font files passed to `registerFont`, so `fontFamily` finds them |
| `debugFrameOverlay`               | `"hidden"`, `"minimal"`, `"full"`                          |
| `renderer`                        | Inject a `TestRenderer` or custom host                     |
| `onEvent`                         | Every dispatched native event                              |
| `onKeyDown` / `onKeyUp`           | Window-level keys                                          |
| `onSelectionChange`               | Window-level selection                                     |
| `onAppearanceChange`              | Window-level light or dark change                          |
| `onUncaughtError`                 | Native and flush errors                                    |

```tsx
render(() => <App />, {
  title: 'Notes',
  width: 800,
  height: 600,
  titlebarTransparent: true,
  windowBackground: 'blurred',
  focus: process.env.GPUIX_BACKGROUND !== '1',
  debugFrameOverlay: 'full',
})
```

**`fonts`** is a convenience over `renderer.registerFont()`: it reads each `.ttf` or `.otf` file and registers its bytes right after the window opens. Pass absolute paths; relative ones resolve against the process's current working directory. An unreadable path throws before the window opens. Ghia ships no fonts. Variable fonts render only their default instance, so pass one static file per weight, and set `fontFamily` to the font's exact family name.

**`createRenderer()`** stays public for tests and custom hosts. Pass `{ renderer }` into `render()` when you already have one.

**`resetRender()`** stops the frame loop and unmounts the global slot. Tests use it between cases.

One renderer drives **one root**. `createRoot()` throws if that renderer already has a mounted root. `render()` unmounts the previous root first.

## `createRoot()`

```ts
function createRoot(
  renderer: NativeRenderer,
  rootHandlers?: RootEventHandlers,
): Root

interface Root {
  render(code: () => JSX.Element): void
  flush(): void
  flushSync<Value>(fn: () => Value): Value
  dispatch(event: EventPayload): boolean
  unmount(): void
}
```

`flush()` sends the mutation queue to native. **`flushSync(fn)`** runs `fn`, then flushes. It does not wait for GPUI paint. Call `renderer.flush()` in a test to see pixels.

```tsx
import { createRoot } from '@ghia/solid'
import { TestRenderer } from '@ghia/solid/testing'

const renderer = new TestRenderer()
const root = createRoot(renderer)
root.render(() => <div>hello</div>)
root.flush()
```

Prefer **`createTestRoot()`** over this pair. It wires event dispatch for you.

## Context

```ts
function useGpuix(): GpuixContextValue | undefined
function useGpuixRequired(): NativeRenderer

interface GpuixContextValue {
  renderer: NativeRenderer
  subscribeSelection(callback: (text: string | null) => void): () => void
}
```

Call them **inside** a tree that `render()` or `createRoot()` mounted.

```tsx
import { useGpuixRequired } from '@ghia/solid'

function WindowControls() {
  const renderer = useGpuixRequired()
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <div onClick={() => renderer.minimizeWindow?.()}>
        <div style={{ color: '#e2e2e2' }}>Minimize</div>
      </div>
      <div onClick={() => renderer.zoomWindow?.()}>
        <div style={{ color: '#e2e2e2' }}>Zoom</div>
      </div>
      <div onClick={() => renderer.toggleFullscreen?.()}>
        <div style={{ color: '#e2e2e2' }}>Fullscreen</div>
      </div>
    </div>
  )
}
```

```tsx
function AttachFiles() {
  const renderer = useGpuixRequired()
  const attach = async () => {
    const paths = await renderer.promptForPaths?.({
      files: true,
      multiple: true,
      prompt: 'Attach',
    })
    if (paths) console.log(paths)
  }
  return (
    <div onClick={attach}>
      <div style={{ color: '#e2e2e2' }}>Attach files</div>
    </div>
  )
}
```

`useGpuix()` returns **`undefined`** outside a root. `useGpuixRequired()` throws.

## Primitives

These are the Solid adapters over `@ghia/native/host`. Call them in a component under an Ghia root. They return **accessors**, not hook objects.

> **Tip.** There is no Solid `useWindowSize`. Use `createWindowSize()`. React keeps `useWindowSize`. The native helpers stay on `@ghia/native/host`.

```ts
function createWindowSize(options?: ObserverOptions): Accessor<WindowSize>
function createWindowInsets(options?: ObserverOptions): Accessor<WindowInsets>
function createSelectedText(): Accessor<string | null>
function createAppearance(): Accessor<'light' | 'dark'>
function createTextSearch(options: Accessor<TextSearchOptions>): {
  readonly props: Pick<HostProps, 'highlight' | 'onHighlight'>
  readonly total: number
  readonly active: number
  next(): void
  previous(): void
  goTo(index: number): void
}
```

```ts
interface ObserverOptions {
  intervalMs?: number | false
}
```

Poll interval defaults to **100 ms**. Pass `intervalMs: false` for one read.

### Window size and insets

```tsx
import { createWindowInsets, createWindowSize } from '@ghia/solid'

function Layout() {
  const size = createWindowSize()
  const insets = createWindowInsets()
  return (
    <div style={{ width: size().width, paddingBottom: insets().ime.bottom }}>
      <div style={{ color: '#e2e2e2' }}>
        {size().width} x {size().height}
      </div>
    </div>
  )
}
```

`examples/solid/chat.tsx` uses **`createWindowInsets()`** so the composer stays above the keyboard.

### Selected text

```tsx
import { createSelectedText } from '@ghia/solid'

function SelectionLabel() {
  const selected = createSelectedText()
  return <div style={{ color: '#e2e2e2' }}>{selected() ?? 'none'}</div>
}
```

### Appearance

```tsx
import { createAppearance } from '@ghia/solid'

function Scheme() {
  const appearance = createAppearance()
  return <div style={{ color: appearance() === 'dark' ? '#e2e2e2' : '#1a1a1a' }}>{appearance()}</div>
}
```

Force it with the `appearance` option or `renderer.setAppearance('light' | 'dark' | 'system')`.

### Find bar

```tsx
import { createSignal } from 'solid-js'
import { createTextSearch } from '@ghia/solid'

function FindBar() {
  const [query, setQuery] = createSignal('')
  const search = createTextSearch(() => ({ query: query() }))
  return (
    <div {...search.props} style={{ height: '100%' }}>
      <input
        value={query()}
        onInput={(event) => setQuery(event.value ?? '')}
      />
      <div style={{ color: '#e2e2e2' }}>
        {search.active + 1} / {search.total}
      </div>
      <div onClick={() => search.next()}>
        <div style={{ color: '#e2e2e2' }}>Next</div>
      </div>
    </div>
  )
}
```

Pass an **accessor** into `createTextSearch`, so a query signal stays live. Spread **`search.props`** onto the container you want to search.

The agnostic helpers still live on **`@ghia/native/host`**: `readWindowSize`, `observeWindowSize`, `createTextSearchController`, `findRanges`. The Solid wrappers add a signal and `onCleanup`.

## Motion

```tsx
import { Show } from 'solid-js'
import { AnimatePresence, motion } from '@ghia/solid'

function WelcomeCard() {
  return (
    <motion.div
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 320, opacity: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      style={{ overflow: 'hidden' }}
    >
      <div style={{ color: '#ffffff' }}>Welcome</div>
    </motion.div>
  )
}

function Toast(props: { visible: boolean }) {
  return (
    <AnimatePresence>
      <Show when={props.visible}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div style={{ color: '#e2e2e2' }}>Saved</div>
        </motion.div>
      </Show>
    </AnimatePresence>
  )
}
```

Numeric targets: **`width`**, **`height`**, **`top`**, **`right`**, **`bottom`**, **`left`**, **`opacity`**, **`borderRadius`**. Duration is seconds. Ease is `"linear"`, `"ease"`, `"easeIn"`, `"easeOut"`, `"easeInOut"`, or `[x1, y1, x2, y2]`.

```ts
function usePresence(): [Accessor<boolean>, () => void]
function useIsPresent(): Accessor<boolean>
```

Outside `AnimatePresence`, `usePresence()` is **`[() => true, noop]`**.

Set **`initial={false}`** when the node must mount at its first `animate` target.

## Headless controls

Unstyled primitives, same split as [Base UI](https://base-ui.com/react/components/select). Import a namespace, wrap it in a local file, then use that file in screens.

Solid names the root **`Select`**, not `Root`.

> **Note.** `@ghia/react/select` exports `Root`. `@ghia/solid/select` exports `Select`. Copy a React snippet only after you rename the root.

```tsx
import { createSignal } from 'solid-js'
import {
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@ghia/solid'

function Controls() {
  const [value, setValue] = createSignal('a')
  return (
    <Select value={value()} onValueChange={setValue}>
      <SelectTrigger style={{ width: 220, height: 36, backgroundColor: '#1e293b' }}>
        <SelectValue placeholder={<div style={{ color: '#94a3b8' }}>Pick</div>} />
      </SelectTrigger>
      <SelectContent style={{ width: 220, backgroundColor: '#0f172a' }}>
        <SelectItem value="a"><div style={{ color: '#e2e8f0' }}>Alpha</div></SelectItem>
        <SelectItem value="b"><div style={{ color: '#e2e8f0' }}>Beta</div></SelectItem>
      </SelectContent>
    </Select>
  )
}
```

Dedicated subpaths:

```ts
import { Select, SelectTrigger, SelectContent, SelectItem } from '@ghia/solid/select'
import { Combobox, ComboboxInput, ComboboxContent, ComboboxItem } from '@ghia/solid/combobox'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@ghia/solid/tooltip'
import { FloatingLayer, renderSlot } from '@ghia/solid/floating'
```

| Root       | Main parts                                                                          |
| ---------- | ----------------------------------------------------------------------------------- |
| `Select`   | `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem`                       |
| `Combobox` | `ComboboxInput`, `ComboboxContent`, `ComboboxList`, `ComboboxItem`, `ComboboxEmpty` |
| `Tooltip`  | `TooltipProvider`, `TooltipTrigger`, `TooltipContent`                               |

`items` on **Select** is optional. It is a label lookup for `SelectValue` while the popup is closed. Keyboard and clicks read the mounted `SelectItem` children.

`style` on **Trigger** and **Item** can be a function of state:

```tsx
<SelectTrigger
  style={(state) => ({
    backgroundColor: state.open ? '#334155' : '#1e293b',
  })}
/>
```

Menus go through **`SelectContent` / `ComboboxContent` / `<anchored deferred>`**. Do not overflow a `position: "absolute"` card into a `<virtual-list>`.

## Testing

Tests run on vitest, under Bun, with the plugins the app uses:

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
import { ghia } from 'ghia'
import { solid } from '@ghia/solid/vite'

export default defineConfig({
  plugins: [ghia(), solid()],
  test: { environment: 'node' },
})
```

```bash
bun --bun vitest run
```

`--bun` runs vitest itself under Bun; without it vitest's `node` shebang wins. Under vitest `ghia()` needs no `entry`. It gives the tests the app's resolution (browser export conditions, one `solid-js`), inlines every dependency, loads `@ghia/native` natively, and runs `@ghia/native/dom-globals` before each test file.

```ts
import { createTestRoot, hasNativeTestRenderer } from '@ghia/solid/testing'

const app = createTestRoot()
app.render(() => (
  <div testId="bump" onClick={() => {}}>
    <div>hi</div>
  </div>
))
app.renderer.nativeSimulateClick(50, 20)
expect(app.renderer.getAllText()).toEqual(['hi'])
app.unmount()
```

```ts
function createTestRoot(options?: TestRendererOptions): TestRoot

interface TestRoot {
  root: Root
  renderer: TestRenderer
  render(code: () => JSX.Element): void
  flushSync<Value>(fn: () => Value): Value
  unmount(): void
}
```

`createTestRoot()` opens **no window**. It uses the GPU test renderer on macOS and Windows. Linux has no test renderer yet.

`createTestRoot({ width, height, fonts })` sizes the offscreen window and registers font files with `registerFont()`, the same as the `fonts` window option.

> **Info.** Prefer `createTestRoot()` when you can. Reach for `launch()` plus `focus: false` when the check needs a real window or a real process.

`getAllText()` only sees the string (`#text`) nodes. For `<code>`, `<diff>`, and `<markdown>`, use `renderer.getPaintedText()`.

The subpath re-exports **`@ghia/native/testing`**, including `TestRenderer` and `hasNativeTestRenderer`.

## Automation

```ts
import { launch } from '@ghia/solid/automation'

const app = await launch({
  command: './node_modules/.bin/ghia',
  args: ['dev'],
  env: { GPUIX_BACKGROUND: '1' },
})
await app.getByTestId('bump').waitFor()
await app.getByTestId('bump').click()
await app.screenshot({ path: 'tmp/after-click.png' })
await app.close()
```

`launch()` sets `GPUIX_AUTOMATION=1` in the app's environment; the app serves automation on stdin only when it is set.

```ts
import { createTestRoot } from '@ghia/solid/testing'
import { connectTest } from '@ghia/solid/automation'

const { renderer, render } = createTestRoot()
render(() => <App />)
const app = await connectTest(renderer)
await app.getByTestId('bump').click()
```

Mark targets with **`testId`**. `click()` hits last painted bounds. `fill()` and `press()` use the live GPUI input pipeline. They do not need window focus.

`@ghia/solid/automation` re-exports **`@ghia/native/automation`**: `launch`, `connectTest`, `connectStdio`, `App`, `Locator`.

A browser `render()` installs **`globalThis.gpuix`**.

## Shared host types

`@ghia/solid` re-exports **`@ghia/native/host`**. App code can import `StyleDesc`, `HostProps`, `findRanges`, and `createMutationQueue` from either package.

```ts
import { GpuixRenderer } from '@ghia/solid'
import type { EventPayload, WindowOptions, StyleDesc } from '@ghia/solid'
```

Host elements are the same as React:

| Element                      | Role                      |
| ---------------------------- | ------------------------- |
| `div`                        | Flex container            |
| `text`                       | Selectable text           |
| `input` / `textarea`         | Native editors            |
| `virtual-list`               | Visible rows only         |
| `code` / `diff` / `markdown` | Native text               |
| `img` / `svg`                | Images and tintable icons |
| `anchored`                   | Positioned overlay        |

JSX adds Solid **`children`** and **`ref`** on top of `HostProps`.

## Compiler internals

These exist because **`babel-preset-solid`** targets `@ghia/solid` as the universal module. Application code does not import them.

```ts
createElement, createTextNode, insert, insertNode, setProp,
spread, memo, effect, createComponent, mergeProps, use
```

```ts
import { jsx, jsxs, Fragment } from '@ghia/solid/jsx-runtime'
```

`jsxImportSource` already points here. Do not import the JSX runtime by hand.

## React vs Solid

|             | React                                        | Solid                                             |
| ----------- | -------------------------------------------- | ------------------------------------------------- |
| JSX         | `"react-jsx"`, `react()` plugin              | `"preserve"`, `solid()` plugin                    |
| Mount       | `render(<App />)`                            | `render(() => <App />)`                           |
| State       | `useState`                                   | `createSignal`                                    |
| Window size | `useWindowSize()`                            | `createWindowSize()`                              |
| Find bar    | `useTextSearch(options)`                     | `createTextSearch(() => options)`                 |
| Select root | `Select.Root`                                | `Select`                                          |
| Tests       | `createTestRoot()` then `root.render(<X />)` | `createTestRoot()` then `app.render(() => <X />)` |
| Run         | `ghia dev`                                   | `ghia dev`                                        |
| Hot reload  | Fast Refresh, `useState` kept                | HMR per component, local signals reset            |
| Bundle      | `ghia build`, then `./dist/app`              | `ghia build`, then `./dist/app`                   |

The native addon, mutation queue, and automation client are shared. A Solid app and a React app can drive the same window types and the same `testId` locators.
