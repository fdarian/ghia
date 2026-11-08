#!/usr/bin/env python3
"""Averages live-split runs per app and prints the per-move and per-crossing tables side by side.

  python3 live-split-compare.py <out dir> <group>=<label>,<label> ... [--crossings 20]

A move is `own:row` (inside row 0: the pointer reaches an element, nothing changes), a crossing is (`own:path` - `own:row`) / crossings.
Instructions are in millions. Per-thread numbers are CPU-time shares of ri_instructions (an estimate); bucket numbers are the main
thread's sample shares x its instructions, minus the idle sample's bucket (see live-split-report.py).
"""
import importlib.util
import sys
from collections import Counter
from pathlib import Path

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("live-split-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

ROLE_ORDER = ["main thread", "NSEventThread", "workers (CA commit, Metal, other)", "wake thread", "JS engine helpers"]
BUCKET_ORDER = [b for b, _ in report.BUCKETS] + [report.OTHER]


def measure(out, label):
    phases = report.parse_phases(f"{out}/{label}.phases.txt")
    main_id = report.main_thread_id(phases)
    idle = phases[0]
    unsampled = {}
    for phase in phases[2:9]:
        unsampled.setdefault(phase["name"], []).append(phase)
    result = {"idle": idle["instr"], "threads": {}, "buckets": {}, "total": {}}
    for name, runs in unsampled.items():
        roles = Counter()
        for run in runs:
            for role, value in report.by_role(run, main_id).items():
                roles[role] += value / len(runs)
        result["threads"][name] = roles
        result["total"][name] = sum(run["instr"] for run in runs) / len(runs)
    idle_main = report.by_role(idle, main_id)["main thread"]
    idle_counts, _ = report.sampled_buckets(out, label, "idle")
    idle_total = sum(idle_counts.values())
    for name in ("hover", "own:out", "own:row", "own:path"):
        counts, _ = report.sampled_buckets(out, label, name)
        total = sum(counts.values())
        main_instr = result["threads"][name]["main thread"]
        seconds = unsampled[name][0]["seconds"]
        result["buckets"][name] = {
            b: main_instr * counts[b] / total - idle_main * idle_counts[b] / idle_total * seconds / idle["seconds"] for b in BUCKET_ORDER
        }
    result["idle_rate"] = {role: value / idle["seconds"] for role, value in report.by_role(idle, main_id).items()}
    result["seconds"] = unsampled["own:row"][0]["seconds"]
    return result


def mean(dicts):
    out = Counter()
    for d in dicts:
        for key, value in d.items():
            out[key] += value / len(dicts)
    return out


def main():
    args = sys.argv[1:]
    crossings = 20
    if "--crossings" in args:
        index = args.index("--crossings")
        crossings = int(args[index + 1])
        del args[index:index + 2]
    out = args[0]
    groups = {}
    for spec_text in args[1:]:
        name, labels = spec_text.split("=")
        groups[name] = [measure(out, label) for label in labels.split(",")]
    names = list(groups)
    events = report.EVENTS

    def table(title, rows, fmt="{:8.3f}"):
        print(f"\n{title}")
        print(f"   {'':<58}" + "".join(f"{n:>10}" for n in names))
        for label, values in rows:
            print(f"   {label:<58}" + "".join(fmt.format(v) if v is not None else f"{'':>10}" for v in values))

    def avg(name, getter):
        return sum(getter(run) for run in groups[name]) / len(groups[name])

    for phase in ("hover", "own:out", "own:row", "own:path"):
        table(f"phase total, M instructions ({phase}, mean of unsampled runs; runs per app: " + ", ".join(f"{n} {len(groups[n])}" for n in names) + ")",
              [("all threads", [avg(n, lambda r: r["total"][phase]) for n in names])], "{:10.1f}")
    table("idle, 10 s, M instructions", [("all threads", [avg(n, lambda r: r["idle"]) for n in names])], "{:10.1f}")

    def per_move(run, role):
        return (run["threads"]["own:row"][role] - run["idle_rate"].get(role, 0) * run["seconds"]) / events

    table("per move (own:row, idle rate removed), M instructions per move, by thread",
          [("total", [avg(n, lambda r: sum(per_move(r, role) for role in ROLE_ORDER)) for n in names])]
          + [(role, [avg(n, lambda r: per_move(r, role)) for n in names]) for role in ROLE_ORDER], "{:10.3f}")
    table("per move (own:row), main-thread bucket, M per move (sample share x instructions - idle baseline)",
          [(b, [avg(n, lambda r: r["buckets"]["own:row"][b] / events) for n in names]) for b in BUCKET_ORDER], "{:10.3f}")
    table("per move (own:out: over the title band), M instructions per move, all threads",
          [("total", [avg(n, lambda r: sum(per_move_out(r, role) for role in ROLE_ORDER)) for n in names])], "{:10.3f}")

    def crossing(run, role):
        return (run["threads"]["own:path"][role] - run["threads"]["own:row"][role]) / crossings

    table(f"per crossing ((own:path - own:row) / {crossings}), M instructions, by thread",
          [("total", [avg(n, lambda r: sum(crossing(r, role) for role in ROLE_ORDER)) for n in names])]
          + [(role, [avg(n, lambda r: crossing(r, role)) for n in names]) for role in ROLE_ORDER], "{:10.3f}")
    table(f"per crossing, main-thread bucket, M",
          [(b, [avg(n, lambda r: (r["buckets"]["own:path"][b] - r["buckets"]["own:row"][b]) / crossings) for n in names]) for b in BUCKET_ORDER], "{:10.3f}")


def per_move_out(run, role):
    return (run["threads"]["own:out"][role] - run["idle_rate"].get(role, 0) * run["seconds"]) / report.EVENTS


main()
