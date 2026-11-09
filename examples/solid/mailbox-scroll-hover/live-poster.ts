// Posts mouse moves to a live window with CGEventPostToPid, the way ghia-bench's harness does (same window-location trick, the
// pointer path of its hover phase, 120 events/s), but with a path of your choice. Prints {beforeNs, afterNs, instructionsBefore,
// instructionsAfter, events} as JSON. Used by live-phase.ts (`own:path|row|out`); run it by hand to post without measuring.
//   bun mailbox-scroll-hover/live-poster.ts <pid> <path|row|out> [count=480] [rateHz=120]
//   path  the bench's hover phase: x=430, y from 84 to 799 and back (a 72 pt row every ~10 events)
//   row   moves between y=90 and y=94 of the first row only: no hover change, the event path without any crossing
//   out   moves in the title bar's band, y=-20..-10 (above the content, no element under the pointer)
// The events go to <pid> alone. The harness's own helper (GHIA_BENCH_HELPER, default ~/code/fdarian/ghia-bench/harness/bin/benchhelper)
// reports the window's frame; nothing is captured and the real cursor does not move.
import { dlopen, ptr } from "bun:ffi"
import { homedir } from "node:os"

const pid = Number(process.argv[2])
const mode = process.argv[3]
const count = Number(process.argv[4] ?? "480")
const rateHz = Number(process.argv[5] ?? "120")
if (!Number.isInteger(pid) || pid <= 0 || !["path", "row", "out"].includes(mode ?? "")) throw new Error("usage: live-poster.ts <pid> <path|row|out> [count] [rateHz]")
const helper = process.env.GHIA_BENCH_HELPER ?? `${homedir()}/code/fdarian/ghia-bench/harness/bin/benchhelper`

const windowStatus = JSON.parse(await new Response(Bun.spawn([helper, "window", "--pid", String(pid)], { stdout: "pipe" }).stdout).text()) as {
  frame: { x: number; y: number; w: number; h: number }
  titlebarHeight: number
}
const originX = windowStatus.frame.x
const originY = windowStatus.frame.y + windowStatus.titlebarHeight

const coreGraphics = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGEventCreateMouseEvent: { args: ["ptr", "u32", "f64", "f64", "u32"], returns: "ptr" },
  CGEventSetIntegerValueField: { args: ["ptr", "u32", "i64"], returns: "void" },
  CGEventPostToPid: { args: ["i32", "ptr"], returns: "void" },
})
const skyLight = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", {
  SLEventSetWindowLocation: { args: ["ptr", "f64", "f64"], returns: "void" },
})
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  mach_absolute_time: { args: [], returns: "u64" },
  mach_wait_until: { args: ["u64"], returns: "i32" },
  mach_timebase_info: { args: ["ptr"], returns: "i32" },
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
})
const MOUSE_MOVED = 5
const MOUSE_DELTA_Y = 4
const WINDOW_NUMBER_FIELD = 51

const timebase = new Uint32Array(2)
libSystem.symbols.mach_timebase_info(ptr(timebase))
const nsToTicks = (ns: number) => Math.round((ns * timebase[1]!) / timebase[0]!)
const ticksToNs = (ticks: bigint) => Number((ticks * BigInt(timebase[0]!)) / BigInt(timebase[1]!))

const rusage = new BigUint64Array(296 / 8)
const instructions = () => {
  if (libSystem.symbols.proc_pid_rusage(pid, 4, ptr(rusage)) !== 0) throw new Error("proc_pid_rusage failed")
  return Number(rusage[248 / 8]!)
}

const coreFoundation = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
  CFArrayGetCount: { args: ["ptr"], returns: "i64" },
  CFArrayGetValueAtIndex: { args: ["ptr", "i64"], returns: "ptr" },
  CFDictionaryGetValue: { args: ["ptr", "ptr"], returns: "ptr" },
  CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
  CFNumberGetValue: { args: ["ptr", "i32", "ptr"], returns: "bool" },
  CFRelease: { args: ["ptr"], returns: "void" },
})
const quartzWindows = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", {
  CGWindowListCopyWindowInfo: { args: ["u32", "u32"], returns: "ptr" },
})
const cString = (text: string) => ptr(Buffer.from(`${text}\0`))
function windowIntegerOf(dictionary: unknown, key: string): number {
  const keyString = coreFoundation.symbols.CFStringCreateWithCString(null, cString(key), 0x08000100)
  const value = coreFoundation.symbols.CFDictionaryGetValue(dictionary as never, keyString)
  coreFoundation.symbols.CFRelease(keyString)
  if (value === null) throw new Error(`window info has no ${key}`)
  const out = new BigInt64Array(1)
  if (!coreFoundation.symbols.CFNumberGetValue(value, 4, ptr(out))) throw new Error(`${key} is not a number`)
  return Number(out[0])
}
// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, as the harness lists windows.
const windowList = quartzWindows.symbols.CGWindowListCopyWindowInfo(1 | 16, 0)
if (windowList === null) throw new Error("CGWindowListCopyWindowInfo failed")
let windowNumber = 0
for (let index = 0; index < Number(coreFoundation.symbols.CFArrayGetCount(windowList)); index++) {
  const entry = coreFoundation.symbols.CFArrayGetValueAtIndex(windowList, BigInt(index))
  if (windowIntegerOf(entry, "kCGWindowOwnerPID") === pid && windowIntegerOf(entry, "kCGWindowLayer") === 0) windowNumber = windowIntegerOf(entry, "kCGWindowNumber")
}
if (windowNumber === 0) throw new Error(`no on-screen layer-0 window for pid ${pid}`)

function move(x: number, y: number, deltaY: number) {
  const event = coreGraphics.symbols.CGEventCreateMouseEvent(null, MOUSE_MOVED, originX + x, originY + y, 0)
  if (event === null) throw new Error("CGEventCreateMouseEvent failed")
  coreGraphics.symbols.CGEventSetIntegerValueField(event, MOUSE_DELTA_Y, BigInt(deltaY))
  if (windowNumber !== 0) coreGraphics.symbols.CGEventSetIntegerValueField(event, WINDOW_NUMBER_FIELD, BigInt(windowNumber))
  skyLight.symbols.SLEventSetWindowLocation(event, x, originY - windowStatus.frame.y + y)
  coreGraphics.symbols.CGEventPostToPid(pid, event)
}

const LIST_TOP = 84
const LIST_BOTTOM = 799
const half = Math.floor(count / 2)
const forward = Array.from({ length: half }, (_, index) => LIST_TOP + ((LIST_BOTTOM - LIST_TOP) * index) / (half - 1))
const ys =
  mode === "path"
    ? [...forward, ...forward.toReversed()]
    : Array.from({ length: count }, (_, index) => (mode === "row" ? 90 + (index % 2) * 4 : -20 + (index % 2) * 10))

move(430, mode === "path" ? LIST_TOP : ys[0]!, 0)
await Bun.sleep(450)
const step = nsToTicks(1e9 / rateHz)
const start = libSystem.symbols.mach_absolute_time() + BigInt(nsToTicks(20e6))
const instructionsBefore = instructions()
const beforeNs = ticksToNs(libSystem.symbols.mach_absolute_time())
for (let index = 0; index < ys.length; index++) {
  const deadline = start + BigInt(index * step)
  const spin = BigInt(nsToTicks(300e3))
  if (libSystem.symbols.mach_absolute_time() + spin < deadline) libSystem.symbols.mach_wait_until(deadline - spin)
  while (libSystem.symbols.mach_absolute_time() < deadline) {}
  move(430, ys[index]!, index === 0 ? 0 : Math.round(ys[index]! - ys[index - 1]!))
}
const afterNs = ticksToNs(libSystem.symbols.mach_absolute_time())
const instructionsAfter = instructions()
console.log(JSON.stringify({ beforeNs, afterNs, instructionsBefore, instructionsAfter, events: ys.length }))
