#!/usr/bin/env python3
"""Cuts a GPUI_GPU_TIMES log by the phases of a PHASE_LOG (live-phase.ts) and prints, per phase, the frames by kind with the GPU time
each took beside the phase's CPU time.

  gpu-times-report.py <gpu log> <phase log> [<gpu log> <phase log> ...]

A gpu line is `<gpu start s> <kind> <w>x<h> encode_ms=<cpu ms to encode> gpu_ms=<GPUEndTime-GPUStartTime> [damage...]`; a phase line is
`<name> <start s> <end s> cpu_ms=<all threads> main_ms=<main thread> instr_m=<M>`; both are on the mach_absolute_time clock.
GPU busy % is the summed gpu_ms over the phase's CPU time (all threads), which is what the energy question asks: how much of the
phase's work is the GPU's."""
import re
import statistics
import sys
from collections import defaultdict


def read_phases(path):
    phases = []
    for line in open(path):
        parts = line.split()
        if len(parts) < 5:
            continue
        fields = dict(part.split("=") for part in parts[3:])
        phases.append((parts[0], float(parts[1]), float(parts[2]), fields))
    return phases


def read_frames(path):
    frames = []
    for line in open(path):
        match = re.match(r"(\S+) (\S+) (\d+)x(\d+) encode_ms=(\S+) gpu_ms=(\S+)(.*)", line)
        if not match:
            continue
        frames.append((float(match.group(1)), match.group(2), (int(match.group(3)), int(match.group(4))), float(match.group(5)), float(match.group(6)), match.group(7).strip()))
    return frames


def pct(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(len(values) * q))]


for gpu_path, phase_path in zip(sys.argv[1::2], sys.argv[2::2]):
    frames = read_frames(gpu_path)
    print(f"== {gpu_path}: {len(frames)} frames, drawable sizes {sorted({frame[2] for frame in frames})}")
    for name, start, end, fields in read_phases(phase_path):
        inside = [frame for frame in frames if start <= frame[0] <= end]
        seconds = end - start
        cpu = float(fields["cpu_ms"])
        main = float(fields["main_ms"])
        gpu_total = sum(frame[4] for frame in inside)
        encode_total = sum(frame[3] for frame in inside)
        print(f"{name}: {seconds:.2f} s, cpu {cpu:.0f} ms (main {main:.0f}), {len(inside)} frames, gpu {gpu_total:.1f} ms = {100 * gpu_total / cpu:.1f}% of cpu, "
              f"{100 * gpu_total / (seconds * 1000):.1f}% of wall; encode {encode_total:.1f} ms")
        kinds = defaultdict(list)
        for frame in inside:
            kinds[frame[1]].append(frame)
        for kind, group in sorted(kinds.items()):
            gpu = [frame[4] for frame in group]
            encode = [frame[3] for frame in group]
            print(f"    {kind:13} n={len(group):4}  gpu ms: mean {statistics.mean(gpu):.3f} p50 {statistics.median(gpu):.3f} p95 {pct(gpu, 0.95):.3f} max {max(gpu):.3f} sum {sum(gpu):.1f};"
                  f"  encode ms mean {statistics.mean(encode):.3f}")
