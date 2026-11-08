#!/usr/bin/env python3
"""Reads what live-split.sh wrote (<label>.phases.txt and <label>.<phase>.sample.txt) and prints the split tables.

  python3 live-split-report.py <out dir> <label> [<label> ...]

Per phase (the unsampled runs): instructions and the threads' share by role, minus the idle rate of the same process, per event.
Per sample: the main thread's non-idle time by bucket (a leaf stack goes to the first bucket whose frames it holds), scaled to the
main thread's instructions of the same phase in the unsampled run (a sampled run pays for the sampler, so its own total is not used).
"""
import re
import sys
from collections import Counter

EVENTS = 480


def parse_phases(path):
    phases = []
    current = None
    for line in open(path, errors="replace"):
        header = re.match(r"^(\S+): ([\d.]+)M instructions in ([\d.]+) s", line)
        if header:
            current = {"name": header.group(1), "instr": float(header.group(2)), "seconds": float(header.group(3)), "threads": []}
            phases.append(current)
            continue
        row = re.match(r"^\s+(\d+)\s+(.*?)\s+([\d.]+) ms\s+([\d.]+)M$", line)
        if row and current is not None:
            current["threads"].append({"id": int(row.group(1)), "name": row.group(2), "ms": float(row.group(3)), "instr": float(row.group(4))})
    return phases


def role(thread, main_id):
    if thread["id"] == main_id:
        return "main thread"
    name = thread["name"]
    if name == "com.apple.NSEventThread":
        return "NSEventThread"
    if name == "gpui run loop wake":
        return "wake thread"
    if re.search(r"Heap Helper|JSC|JIT|mi-scavenger|Bun Pool|HTTP Client|File Poller", name):
        return "JS engine helpers"
    return "workers (CA commit, Metal, other)"


ROLES = ["main thread", "NSEventThread", "workers (CA commit, Metal, other)", "wake thread", "JS engine helpers"]


def by_role(phase, main_id):
    totals = Counter()
    for thread in phase["threads"]:
        totals[role(thread, main_id)] += thread["instr"]
    return totals


def main_thread_id(phases):
    ids = [thread["id"] for phase in phases for thread in phase["threads"]]
    return min(ids)


BUCKETS = [
    ("Metal present (encode, commit)", r"MetalRenderer|metal_renderer|Window7present|PlatformWindow4draw|nextDrawable"),
    ("frame build (Window::draw: build, layout, prepaint, paint)", r"Window4draw|draw_if_dirty"),
    ("CATransaction flush/commit", r"CA::Transaction|CA::Context"),
    ("Ghia pointer dispatch (listeners, submit, handle_pointer)", r"events9listeners|events10dispatcher|handle_pointer|dispatch_sample"),
    ("GPUI dispatch_event (hit test, listeners)", r"handle_view_event|dispatch_view_event|Window14dispatch_event"),
    ("AppKit event delivery (sendEvent, dequeue, convert)", r"sendEvent|nextEventMatching|Convert1CGEvent|ReceiveNextEvent|_NSSendEventToDequeuingObservers|routeMouseMoved"),
    ("AppKit window update / run loop observers", r"setWindowsNeedUpdate|updateWindows|__CFRunLoopDoObservers|DriverCore"),
    ("Ghia tick other (pump, napi, effects)", r"GpuixRenderer4tick|tick_c_callback"),
]
OTHER = "other (JS, runtime, display link wait)"
def is_idle(names):
    joined = "\n".join(names)
    if names[-1].startswith("kevent64"):
        return True
    return "__CFRunLoopServiceMachPort" in joined and "pump_events" not in joined
LINE = re.compile(r"^([ +!:|]*?)(\d+) (.*)$")


def main_thread_stacks(path):
    lines = open(path, errors="replace").read().split("\n")
    start = next(i for i, line in enumerate(lines) if re.match(r"^    \d+ Thread_\d+.*(Main Thread|com.apple.main-thread|: main$)", line))
    stack, nodes = [], []
    for line in lines[start:]:
        if re.match(r"^    \d+ Thread_", line) and nodes:
            break
        m = LINE.match(line)
        if not m:
            continue
        depth, count, name = len(m.group(1)), int(m.group(2)), re.sub(r"\s+\(in [^)]*\).*$", "", m.group(3))
        name = re.sub(r"\s+\+\s+\d+\s+\[0x[0-9a-f]+\]$", "", name)
        while stack and stack[-1]["depth"] >= depth:
            stack.pop()
        node = {"depth": depth, "count": count, "name": name, "kids": 0}
        if stack:
            stack[-1]["kids"] += count
        stack.append(node)
        nodes.append((node, [n["name"] for n in stack]))
    for node, names in nodes:
        self_count = node["count"] - node["kids"]
        if self_count > 0:
            yield self_count, names


def bucket_shares(path):
    counts, idle = Counter(), 0
    for self_count, names in main_thread_stacks(path):
        if is_idle(names):
            idle += self_count
            continue
        joined = "\n".join(names)
        for label, pattern in BUCKETS:
            if re.search(pattern, joined):
                counts[label] += self_count
                break
        else:
            counts[OTHER] += self_count
    return counts, idle


def sampled_buckets(out, label, phase):
    counts = Counter()
    idle = 0
    for rep in (1, 2, 3):
        c, i = bucket_shares(f"{out}/{label}.{phase.replace(':', '-')}.sample{rep}.txt")
        counts.update(c)
        idle += i
    return counts, idle


def main():
    out, labels = sys.argv[1], sys.argv[2:]
    for label in labels:
        phases = parse_phases(f"{out}/{label}.phases.txt")
        main_id = main_thread_id(phases)
        idle = phases[0]
        assert idle["name"] == "idle"
        idle_rate = {r: v / idle["seconds"] for r, v in by_role(idle, main_id).items()}
        print(f"\n== {label}: idle {idle['instr']:.1f}M / {idle['seconds']:.1f} s; main thread {main_id}")
        print("   phase (unsampled)  total   " + "  ".join(f"{r.split(' (')[0][:12]:>12}" for r in ROLES) + "   per event, idle rate removed (M): total  main  NSEv  other")
        unsampled = {}
        for phase in phases[2:9]:
            totals = by_role(phase, main_id)
            net = {r: totals[r] - idle_rate.get(r, 0) * phase["seconds"] for r in ROLES}
            other = sum(net[r] for r in ROLES if r not in ("main thread", "NSEventThread"))
            print(f"   {phase['name']:<16} {phase['instr']:7.1f}  " + "  ".join(f"{totals[r]:12.1f}" for r in ROLES)
                  + f"   {sum(net.values()) / EVENTS:6.3f} {net['main thread'] / EVENTS:6.3f} {net['NSEventThread'] / EVENTS:6.3f} {other / EVENTS:6.3f}")
            unsampled.setdefault(phase["name"], []).append((totals["main thread"], phase["seconds"]))
        idle_main = by_role(idle, main_id)["main thread"]
        idle_counts, idle_idle = sampled_buckets(out, label, "idle")
        idle_total = sum(idle_counts.values())
        print(f"   main thread, 1 ms samples x3: share of non-idle samples x main-thread instructions of the unsampled runs (mean of the two)")
        print(f"   idle (4 s sample baseline): {idle_total} non-idle, {idle_idle} idle samples; main thread {idle_main:.1f}M in 10 s")
        for bucket, count in idle_counts.most_common():
            print(f"      {100 * count / idle_total:5.1f}%  {idle_main * count / idle_total:6.1f}M per 10 s  {bucket}")
        results = {}
        for phase_name in ("hover", "own:out", "own:row", "own:path"):
            counts, idle_samples = sampled_buckets(out, label, phase_name)
            total = sum(counts.values())
            instr = sum(t for t, _ in unsampled[phase_name]) / len(unsampled[phase_name])
            seconds = sum(sec for _, sec in unsampled[phase_name]) / len(unsampled[phase_name])
            per_bucket = {}
            for bucket in [b for b, _ in BUCKETS] + [OTHER]:
                phase_m = instr * counts[bucket] / total
                baseline_m = idle_main * idle_counts[bucket] / idle_total * seconds / idle["seconds"]
                per_bucket[bucket] = (counts[bucket], phase_m, phase_m - baseline_m)
            results[phase_name] = per_bucket
            print(f"   {phase_name}: {total} non-idle, {idle_samples} idle samples (3 runs); main thread {instr:.1f}M in {seconds:.2f} s unsampled")
            print(f"      {'share':>6} {'M':>7} {'M - idle':>9} {'per move (M)':>13}  bucket")
            for bucket, (count, phase_m, net_m) in sorted(per_bucket.items(), key=lambda kv: -kv[1][1]):
                if count:
                    print(f"      {100 * count / total:5.1f}% {phase_m:7.1f} {net_m:9.1f} {net_m / EVENTS:13.3f}  {bucket}")
        crossings = 20
        for base in ("own:out", "own:row"):
            print("   per crossing (own:path - %s), M, over ~%d crossings:" % (base, crossings))
            for bucket in [b for b, _ in BUCKETS] + [OTHER]:
                difference = results["own:path"][bucket][1] - results[base][bucket][1]
                if abs(difference) >= 0.5:
                    print(f"      {difference:7.1f}M total {difference / crossings:7.3f}M per crossing  {bucket}")


if __name__ == "__main__":
    main()
