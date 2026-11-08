// Runs one input phase of ghia-bench's harness against a live window and prints what it costs, split by thread.
//   bun mailbox-scroll-hover/live-phase.ts <pid> [hover|scroll|idle|own:path|own:row|own:out ...]      (default: hover)
// `own:<mode>` posts with live-poster.ts instead of the harness (mode path = the harness's hover path; row = moves inside one row,
// so the pointer never crosses a row; out = moves over the title bar's band). EVENTS=480 and RATE=120 set their count and rate.
// <pid> is a process you started (`live.tsx` here, with `focus: false`); the harness posts its events with CGEventPostToPid to that
// pid and nothing else, takes no screenshot (no --capture) and does not move the real cursor.
//   GHIA_BENCH_HELPER  path of ghia-bench's harness/bin/benchhelper (default: ~/code/fdarian/ghia-bench/harness/bin/benchhelper)
//   SECONDS=10         length of an idle phase
//   POLL_MS=10         how often the threads' CPU times and the instructions are read
//   BUCKET_MS=250      width of the buckets of the instructions timeline (0 turns it off)
// Output: the phase's ri_instructions (from the harness's own before/after samples, as the bench reports them), then each thread's
// user+system CPU time between the same two instants. A thread's share of the instructions is its share of the CPU time; that is an
// estimate (IPC differs between threads), proc_pid_rusage has no per-thread instructions.
import { dlopen, ptr } from "bun:ffi"
import { homedir } from "node:os"

const pid = Number(process.argv[2])
if (!Number.isInteger(pid) || pid <= 0) throw new Error("usage: live-phase.ts <pid> [phase ...]")
const phases = process.argv.length > 3 ? process.argv.slice(3) : ["hover"]
const helper = process.env.GHIA_BENCH_HELPER ?? `${homedir()}/code/fdarian/ghia-bench/harness/bin/benchhelper`
const POLL_MS = Number(process.env.POLL_MS ?? "10")
const BUCKET_MS = Number(process.env.BUCKET_MS ?? "250")

const PROC_PIDLISTTHREADIDS = 28
const PROC_PIDTHREADID64INFO = 15
const THREADINFO_SIZE = 112
const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
  proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
  mach_absolute_time: { args: [], returns: "u64" },
  mach_timebase_info: { args: ["ptr"], returns: "i32" },
  proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
})
// <sys/resource.h>: offsetof(struct rusage_info_v4, ri_instructions) = 248, sizeof = 296.
const RUSAGE_INFO_V4 = 4
const RI_INSTRUCTIONS = 248
const rusageBuffer = new BigUint64Array(296 / 8)
const rusageView = new DataView(rusageBuffer.buffer)
function readInstructions(): number {
  if (libSystem.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(rusageBuffer)) !== 0) throw new Error(`proc_pid_rusage failed for ${pid}`)
  return Number(rusageView.getBigUint64(RI_INSTRUCTIONS, true))
}
const timebase = new Uint32Array(2)
libSystem.symbols.mach_timebase_info(ptr(timebase))
const ticksToNs = (ticks: bigint) => Number((ticks * BigInt(timebase[0]!)) / BigInt(timebase[1]!))
const nowNs = () => ticksToNs(libSystem.symbols.mach_absolute_time())

type ThreadTimes = { name: string; cpuNs: number }
type Snapshot = { tNs: number; instructions: number; threads: Map<string, ThreadTimes> }

const idBuffer = new BigUint64Array(1024)
const infoBuffer = new ArrayBuffer(THREADINFO_SIZE)
const infoView = new DataView(infoBuffer)
const infoAddress = ptr(infoBuffer)

function snapshot(): Snapshot {
  const tNs = nowNs()
  const instructions = readInstructions()
  const bytes = libSystem.symbols.proc_pidinfo(pid, PROC_PIDLISTTHREADIDS, 0n, ptr(idBuffer), idBuffer.byteLength)
  if (bytes <= 0) throw new Error(`proc_pidinfo(PROC_PIDLISTTHREADIDS) failed for ${pid}`)
  const threads = new Map<string, ThreadTimes>()
  for (let index = 0; index < bytes / 8; index++) {
    const id = idBuffer[index]!
    const written = libSystem.symbols.proc_pidinfo(pid, PROC_PIDTHREADID64INFO, id, infoAddress, THREADINFO_SIZE)
    if (written !== THREADINFO_SIZE) continue
    const user = Number(infoView.getBigUint64(0, true))
    const system = Number(infoView.getBigUint64(8, true))
    const raw = new Uint8Array(infoBuffer, 48, 64)
    const end = raw.indexOf(0)
    const name = new TextDecoder().decode(raw.subarray(0, end < 0 ? 64 : end))
    threads.set(String(id), { name, cpuNs: user + system })
  }
  return { tNs, instructions, threads }
}

type Procs = { tNs: number; procs: { pid: number; instructions: number; userNs: number; sysNs: number }[] }
type PhaseResult = { name: string; rusageBefore: Procs; rusageAfter: Procs; rusageAfterTail: Procs; inputs: { tNs: number }[] }

type PosterOutput = { beforeNs: number; afterNs: number; instructionsBefore: number; instructionsAfter: number; events: number }
function fromPoster(name: string, output: PosterOutput): PhaseResult {
  const sample = (tNs: number, instructions: number): Procs => ({ tNs, procs: [{ pid, instructions, userNs: 0, sysNs: 0 }] })
  return {
    name,
    rusageBefore: sample(output.beforeNs, output.instructionsBefore),
    rusageAfter: sample(output.afterNs, output.instructionsAfter),
    rusageAfterTail: sample(output.afterNs, output.instructionsAfter),
    inputs: Array.from({ length: output.events }, () => ({ tNs: 0 })),
  }
}

const instructionsOf = (sample: Procs) => sample.procs.reduce((total, proc) => total + proc.instructions, 0)
const cpuNsOf = (sample: Procs) => sample.procs.reduce((total, proc) => total + proc.userNs + proc.sysNs, 0)
const nearest = (snapshots: Snapshot[], tNs: number) =>
  snapshots.reduce((best, candidate) => (Math.abs(candidate.tNs - tNs) < Math.abs(best.tNs - tNs) ? candidate : best))

async function runPhase(name: string) {
  const snapshots: Snapshot[] = []
  const timer = setInterval(() => snapshots.push(snapshot()), POLL_MS)
  const own = name.startsWith("own:")
  const command = own
    ? [process.execPath, `${import.meta.dir}/live-poster.ts`, String(pid), name.slice(4), process.env.EVENTS ?? "480", process.env.RATE ?? "120"]
    : [helper, "phase", "--pid", String(pid), "--name", name, ...(name === "idle" ? ["--seconds", process.env.SECONDS ?? "10"] : [])]
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearInterval(timer)
  if (code !== 0) throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`)
  const result: PhaseResult = own ? fromPoster(name, JSON.parse(stdout)) : (JSON.parse(stdout) as PhaseResult)

  const instructions = instructionsOf(result.rusageAfter) - instructionsOf(result.rusageBefore)
  const tail = instructionsOf(result.rusageAfterTail) - instructionsOf(result.rusageAfter)
  const seconds = (result.rusageAfter.tNs - result.rusageBefore.tNs) / 1e9
  const first = nearest(snapshots, result.rusageBefore.tNs)
  const last = nearest(snapshots, result.rusageAfter.tNs)
  const cpuMs = (cpuNsOf(result.rusageAfter) - cpuNsOf(result.rusageBefore)) / 1e6
  console.log(`\n${name}: ${(instructions / 1e6).toFixed(1)}M instructions in ${seconds.toFixed(3)} s, ${result.inputs.length} inputs; the 0.5 s tail after: ${(tail / 1e6).toFixed(1)}M`)
  console.log(`  snapshot error: before ${((first.tNs - result.rusageBefore.tNs) / 1e6).toFixed(1)} ms, after ${((last.tNs - result.rusageAfter.tNs) / 1e6).toFixed(1)} ms; ${snapshots.length} snapshots`)

  if (BUCKET_MS > 0) {
    const inside = snapshots.filter((candidate) => candidate.tNs >= first.tNs && candidate.tNs <= last.tNs)
    const buckets: number[] = []
    for (let index = 1; index < inside.length; index++) {
      const bucket = Math.floor((inside[index]!.tNs - first.tNs) / 1e6 / BUCKET_MS)
      buckets[bucket] = (buckets[bucket] ?? 0) + (inside[index]!.instructions - inside[index - 1]!.instructions)
    }
    console.log(`  timeline, M instructions per ${BUCKET_MS} ms: ${Array.from(buckets, (value) => ((value ?? 0) / 1e6).toFixed(0)).join(" ")}`)
  }

  const rows: { id: string; name: string; ms: number }[] = []
  for (const [id, after] of last.threads) {
    const before = first.threads.get(id)
    rows.push({ id, name: after.name, ms: (after.cpuNs - (before?.cpuNs ?? 0)) / 1e6 })
  }
  const total = rows.reduce((sum, row) => sum + row.ms, 0)
  rows.sort((a, b) => b.ms - a.ms)
  console.log(`  threads (cpu ms between the same instants; sum ${total.toFixed(0)} ms; estimated M instr = share x ${(instructions / 1e6).toFixed(1)}M):`)
  for (const row of rows.filter((candidate) => candidate.ms >= 0.5)) {
    console.log(`    ${row.id.padStart(10)}  ${(row.name || "(unnamed)").padEnd(36)} ${row.ms.toFixed(1).padStart(8)} ms  ${((row.ms / total) * instructions / 1e6).toFixed(1).padStart(7)}M`)
  }
  const mainId = [...last.threads.keys()].reduce((lowest, id) => (BigInt(id) < BigInt(lowest) ? id : lowest))
  const roleOf = (row: { id: string; name: string }) => {
    if (row.id === mainId) return "main thread (JS, GPUI, AppKit pump)"
    if (row.name === "com.apple.NSEventThread") return "NSEventThread (AppKit receives the events)"
    if (row.name === "gpui run loop wake") return "gpui run loop wake (wakes JS)"
    if (/Heap Helper|JSC|JIT|mi-scavenger|Bun Pool/.test(row.name)) return "JS engine helpers (GC, JIT, allocator)"
    if (row.name === "CVDisplayLink") return "display link"
    if (row.name === "") return "unnamed (libdispatch workers: Core Animation, Metal)"
    return row.name
  }
  const roles = new Map<string, number>()
  for (const row of rows) roles.set(roleOf(row), (roles.get(roleOf(row)) ?? 0) + row.ms)
  console.log("  by role:")
  for (const [role, ms] of [...roles].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${role.padEnd(56)} ${ms.toFixed(1).padStart(8)} ms  ${((ms / total) * instructions / 1e6).toFixed(1).padStart(7)}M`)
  }
  const gone = [...first.threads].filter(([id]) => !last.threads.has(id))
  if (gone.length > 0) console.log(`  ${gone.length} thread(s) present before and gone after (their time is not counted)`)
}

for (const name of phases) await runPhase(name)
