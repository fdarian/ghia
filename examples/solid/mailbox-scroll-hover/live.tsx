// The bench's Mailbox in a real window that does not take focus, for measuring a live phase from outside (see "Driving a
// live window" and "Measuring performance" in docs/fork/testing.md). App.tsx and types.ts are the bench app's, verbatim as in profile.tsx.
//   cd examples && NODE_ENV=production GHIA_BENCH_MESSAGES=/path/to/ghia-bench/data/messages.json bun run mailbox-live
// GPUIX_BACKGROUND=1 emulates focus, so the search input's caret blinks as it does in the bench's key window.
import { readFileSync } from "node:fs"
import { render } from "@ghia/solid"
import { App } from "./App"
import type { Message } from "./types"

const MESSAGES_PATH = process.env.GHIA_BENCH_MESSAGES
if (!MESSAGES_PATH) throw new Error("GHIA_BENCH_MESSAGES must be the path of ghia-bench's data/messages.json")
const messages = JSON.parse(readFileSync(MESSAGES_PATH, "utf8")) as Message[]

render(() => <App messages={messages} />, {
  title: "Mailbox",
  width: 1280,
  height: 800,
  x: 100,
  y: 100,
  appearance: "light",
  focus: false,
})
