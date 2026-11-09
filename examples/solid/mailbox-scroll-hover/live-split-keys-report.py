#!/usr/bin/env python3
"""Prints the per-keystroke split of the bench's type and navigate phases, GPUI against Ghia (reads what live-split-keys.sh wrote).

  python3 live-split-keys-report.py <out dir> gpui=gpui1,gpui2,gpui3 ghia=ghia1,ghia2,ghia3 [first:gpui=gpuiF1,.. first:ghia=ghiaF1,..] [--functions N] [--buckets N] [--subtract-idle]

The optional first:<group> labels are runs of live-split-keys.sh with FIRST=1 (the first type and navigate of a session under `sample`).

<out dir>/<label>.phases.txt holds idle, scroll, hover, then (type, navigate) x3 unsampled, then the sampled (idle, type, navigate) x3.
Events: type 32 keystrokes (16 characters + 16 backspaces, 150 ms apart), navigate 30 ArrowDown (120 ms apart).

Totals and threads: ri_instructions of the phase, minus the idle rate of the same process x the phase's length, per event; per-thread numbers
are CPU-time shares (an estimate). "first" is the first type/navigate of the session (what the bench measures), "steady" the mean of the
second and third. Buckets: the main thread's 1 ms samples of the sampled repetitions (steady state), each non-idle sample assigned to the
bucket of the innermost frame of its stack that a pattern below matches, times the steady main-thread instructions of the phase, minus the
idle sample's share x idle rate x the phase's length (the caret blink and GPUI's redraws for it).
"""
import importlib.util
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

spec = importlib.util.spec_from_file_location("report", Path(__file__).with_name("live-split-report.py"))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

EVENTS = {"type": 32, "navigate": 30}
# Off by default: GPUI's app pauses the caret blink for 500 ms after each edit, so during type (a key every 150 ms) none of the idle
# rate (a whole-tree redraw per blink) is there to remove, while Ghia's idle rate is mostly JS timers and GC that do continue.
SUBTRACT_IDLE = False

# Checked per frame from the leaf up, in this order; the first frame with a match decides the bucket.
BUCKETS = [
    ("Metal present", r"MetalRenderer|metal_renderer|Window7present|nextDrawable|AGX|IOGPU|MTLCommand|CAMetalLayer|PlatformWindow4draw"),
    ("glyph raster / atlas (inside paint)", r"raster_bounds|rasterize|atlas|Atlas|CGGlyph|CTFontDraw|CGContext|CGBitmap|CGFont"),
    ("text shaping (CoreText line layout, shape_text)", r"11text_system|shape_text|shape_line|layout_line|CTLine|TTypesetter|CTFont|OTL::|ItemVariationStore|TGlyph|TShaper|TFont|LineWrapper|CTRun|TRun|TLine"),
    ("Ghia napi: applyBatch (Rust side)", r"apply_batch|applyBatch|BatchOp|retained_tree"),
    ("Ghia retain / tape / replay bookkeeping", r"gpuix_native6retain|gpuix_native4tape|gpuix_native5scroll|8retained8Retained|7replay|replay_translated|patch_splice|scroll_patch"),
    ("layout (request_layout, taffy, list measure)", r"taffy|compute_layout|request_layout|layout_as_root|layout_root|layout_items|LayoutEngine|run_taffy|gpuix_native6layout|measure"),
    ("prepaint", r"prepaint"),
    ("paint", r"(?<![a-z])\d+paint(?![a-rt-z])|(?<!pre)paint_|Scene|scene|BoundsTree|bounds_tree|insert_primitive"),
    ("element build (GPUI app render / Ghia build_element)", r"build_element|build_content|build_plan|build_virtual_child|build_patch|Render6render|any_view6render|7Mailbox\d+render|9processor|style_desc|StyleDesc|gpuix_native5style|resolve_style"),
    ("GPUI app logic (filter, state, TextInput)", r"apply_filter|Mailbox\d+(?:new|select|move|set_)|TextInput|input9"),
    ("Ghia pointer/key dispatch (listeners, submit)", r"gpuix_native6events\d+(?:dispatcher|listeners|keyboard|state|element|focus)|gpuix_native5focus|gpuix_native5forms|handle_key|keyboard_defaults|submit_event"),
    ("GPUI dispatch_event / key dispatch", r"Window14dispatch_event|dispatch_key_event|dispatch_keystroke|dispatch_action|handle_key_event|handle_view_event|dispatch_view_event|dispatch_mouse|keystroke|hit_test|dom_hit"),
    ("JS engine (Bun/JSC: Solid effects, handlers)", r"^\?\?\?$|JSC|WTF::|bun|call_js_cb"),
    ("Ghia napi glue (event payload, tick, pump)", r"napi|GpuixRenderer4tick|tick_c_callback|sync_dispatch|pump_events|native_callb"),
    ("AppKit event delivery (sendEvent, text input, dequeue)", r"sendEvent|NSTextInputContext|TSM|IMK|InputAnalytics|nextEventMatching|ReceiveNextEvent|_NSSendEventToDequeuingObservers|routeMouseMoved|Convert1CGEvent|_DPSNextEvent|NSEvent|NSResponder|keyDown|performKeyEquivalent"),
    ("CATransaction flush/commit", r"CA::Transaction|CA::Context|CA::Layer|CA::Display|display_timer_callback"),
    ("AppKit window update / run loop observers", r"setWindowsNeedUpdate|updateWindows|__CFRunLoopDoObservers|DriverCore|NSWindow|NSView|NSApplication"),
    ("frame build other (Window::draw, build_next_frame, window)", r"Window4draw|build_next_frame|draw_if_dirty|Window\d+(?:with_|transact|paint_|prepaint|layout|draw)"),
]
COMPILED = [(name, re.compile(pattern)) for name, pattern in BUCKETS]
OTHER = "other (runtime, malloc, unattributed)"
ORDER = [name for name, _ in BUCKETS] + [OTHER]


def classify(names):
    for frame in reversed(names):
        for bucket, pattern in COMPILED:
            if pattern.search(frame):
                return bucket, frame
    return OTHER, names[-1]


def readable(frame):
    """A Rust v0 symbol reduced to its identifiers, last three."""
    if not frame.startswith("_R"):
        return re.sub(r"\(.*", "", frame)[:90]
    text = re.sub(r"C[a-z][0-9A-Za-z]{5,}_", "", frame)
    identifiers, position = [], 0
    while position < len(text):
        if text[position].isdigit():
            end = position
            while end < len(text) and text[end].isdigit():
                end += 1
            length = int(text[position:end])
            candidate = text[end:end + length]
            if length > 0 and len(candidate) == length and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", candidate):
                identifiers.append(candidate)
                position = end + length
                continue
        position += 1
    return "::".join(identifiers[-3:]) if identifiers else frame[:90]


def sample_counts(out, label, phase, reps=(1, 2, 3)):
    """(bucket counter, (bucket, frame) counter, non-idle total, idle total) over the sampled repetitions."""
    buckets, frames = Counter(), Counter()
    idle = 0
    for rep in reps:
        for count, names in report.main_thread_stacks(f"{out}/{label}.{phase}.sample{rep}.txt"):
            if report.is_idle(names):
                idle += count
                continue
            bucket, frame = classify(names)
            buckets[bucket] += count
            frames[(bucket, readable(frame))] += count
    return buckets, frames, sum(buckets.values()), idle


def attribute(main_instr, idle_main, counts, idle_counts, name):
    """Per-event net M instructions of each bucket and (bucket, frame): sample share x main-thread instructions - idle baseline."""
    buckets, frames, total, _ = counts
    idle_buckets, idle_frames, idle_total, _ = idle_counts
    idle_main = idle_main if SUBTRACT_IDLE else 0
    net_buckets = {b: (main_instr * buckets[b] / total - idle_main * idle_buckets[b] / idle_total) / EVENTS[name] for b in ORDER}
    net_frames = {key: (main_instr * frames[key] / total - idle_main * idle_frames[key] / idle_total) / EVENTS[name] for key in set(frames) | set(idle_frames)}
    return net_buckets, net_frames, total


def role_table(runs, idle_rate, seconds, name):
    roles = Counter()
    for run, main_id in runs:
        for role, value in report.by_role(run, main_id).items():
            roles[role] += value / len(runs)
    return {role: (roles[role] - (idle_rate.get(role, 0) * seconds if SUBTRACT_IDLE else 0)) / EVENTS[name] for role in report.ROLES}


def measure(out, label):
    phases = report.parse_phases(f"{out}/{label}.phases.txt")
    main_id = report.main_thread_id(phases)
    idle = phases[0]
    assert idle["name"] == "idle" and [p["name"] for p in phases[3:9]] == ["type", "navigate"] * 3, [p["name"] for p in phases]
    idle_rate = {role: value / idle["seconds"] for role, value in report.by_role(idle, main_id).items()}
    result = {"label": label, "idle": idle["instr"], "idle_rate": idle_rate, "phase": {}, "main_id": main_id}
    idle_counts = sample_counts(out, label, "idle")
    for name, offset in (("type", 3), ("navigate", 4)):
        runs = [phases[offset + 2 * index] for index in range(3)]
        seconds = runs[0]["seconds"]
        idle_total = sum(idle_rate.values()) * seconds if SUBTRACT_IDLE else 0
        steady_roles = role_table([(run, main_id) for run in runs[1:]], idle_rate, seconds, name)
        first_roles = role_table([(runs[0], main_id)], idle_rate, seconds, name)
        main_steady = (sum(report.by_role(run, main_id)["main thread"] for run in runs[1:]) / 2)
        buckets, frames, total = attribute(main_steady, idle_rate["main thread"] * seconds, sample_counts(out, label, name), idle_counts, name)
        result["phase"][name] = {
            "runs": [run["instr"] for run in runs], "seconds": seconds,
            "first": {"roles": first_roles, "total": (runs[0]["instr"] - idle_total) / EVENTS[name], "main_instr": report.by_role(runs[0], main_id)["main thread"]},
            "steady": {"roles": steady_roles, "total": (sum(run["instr"] for run in runs[1:]) / 2 - idle_total) / EVENTS[name],
                       "buckets": buckets, "frames": frames, "samples": total},
        }
    return result


def attach_first(out, results, first_labels):
    """The first type/navigate of a session under `sample` (live-split-keys.sh with FIRST=1): shares x the unsampled first-run instructions."""
    for result, label in zip(results, first_labels):
        phases = report.parse_phases(f"{out}/{label}.phases.txt")
        main_id = report.main_thread_id(phases)
        assert [p["name"] for p in phases] == ["idle", "scroll", "hover", "type", "navigate", "idle"], [p["name"] for p in phases]
        idle_counts = sample_counts(out, label, "idle", reps=(1,))
        for name in ("type", "navigate"):
            entry = result["phase"][name]
            buckets, frames, total = attribute(entry["first"]["main_instr"], result["idle_rate"]["main thread"] * entry["seconds"],
                                               sample_counts(out, label, name, reps=(1,)), idle_counts, name)
            entry["first"].setdefault("buckets_runs", []).append((buckets, frames, total))


def mean_dict(dicts):
    out = Counter()
    for d in dicts:
        for key, value in d.items():
            out[key] += value / len(dicts)
    return out


def main():
    args = sys.argv[1:]
    global SUBTRACT_IDLE
    top_functions, top_buckets = 6, 4
    if "--subtract-idle" in args:
        SUBTRACT_IDLE = True
        args.remove("--subtract-idle")
    if "--functions" in args:
        index = args.index("--functions")
        top_functions = int(args[index + 1])
        del args[index:index + 2]
    if "--buckets" in args:
        index = args.index("--buckets")
        top_buckets = int(args[index + 1])
        del args[index:index + 2]
    out = args[0]
    groups, firsts = {}, {}
    for text in args[1:]:
        if text.startswith("first:"):
            name, labels = text[len("first:"):].split("=")
            firsts[name] = labels.split(",")
        else:
            name, labels = text.split("=")
            groups[name] = [measure(out, label) for label in labels.split(",")]
    for name, labels in firsts.items():
        attach_first(out, groups[name], labels)
    names = list(groups)
    reference, subject = names[0], names[-1]
    have_first = bool(firsts)
    width = 9

    def avg(group, getter):
        runs = groups[group]
        return sum(getter(run) for run in runs) / len(runs)

    def first_buckets(group, phase):
        merged = mean_dict([bucket for run in groups[group] for bucket, _, _ in run["phase"][phase]["first"]["buckets_runs"]])
        return merged

    def first_frames(group, phase):
        return mean_dict([frames for run in groups[group] for _, frames, _ in run["phase"][phase]["first"]["buckets_runs"]])

    print("idle 10 s, M: " + ", ".join(f"{n} {avg(n, lambda r: r['idle']):.1f}" for n in names))
    for phase in ("type", "navigate"):
        events = EVENTS[phase]
        print(f"\n===== {phase} ({events} events; runs per app: " + ", ".join(f"{n} {len(groups[n])}" for n in names) + ")")
        print("phase instructions, M (1st = first in session = the bench's number; 2nd, 3rd = repetitions in the same process)")
        for n in names:
            print(f"   {n:<6} 1st/2nd/3rd per run: " + "   ".join("/".join(f"{v:6.1f}" for v in r["phase"][phase]["runs"]) for r in groups[n]))
        head = "".join(f"{n + ' 1st':>{width}}" for n in names) + f"{'diff':>{width}}" + "".join(f"{n + ' 2-3':>{width}}" for n in names) + f"{'diff':>{width}}"
        print(f"\nper event, M instructions{' (idle rate removed)' if SUBTRACT_IDLE else ''}")
        print(" " * 57 + head)

        def row(label, first_getter, steady_getter, indent=""):
            f = [avg(n, first_getter) for n in names]
            st = [avg(n, steady_getter) for n in names]
            print(f"   {indent + label:<54}" + "".join(f"{v:{width}.3f}" for v in f) + f"{f[-1] - f[0]:{width}.3f}"
                  + "".join(f"{v:{width}.3f}" for v in st) + f"{st[-1] - st[0]:{width}.3f}")

        row("total", lambda r: r["phase"][phase]["first"]["total"], lambda r: r["phase"][phase]["steady"]["total"])
        for role in report.ROLES:
            row(role, (lambda role: lambda r: r["phase"][phase]["first"]["roles"][role])(role),
                (lambda role: lambda r: r["phase"][phase]["steady"]["roles"][role])(role), "  ")

        print(f"\nmain-thread buckets per event, M (sample share x main-thread instructions). 1st: samples of the first run in the session"
              f"{' (' + str(round(avg(reference, lambda r: sum(t for _, _, t in r['phase'][phase]['first']['buckets_runs'])))) + '/' + str(round(avg(subject, lambda r: sum(t for _, _, t in r['phase'][phase]['first']['buckets_runs'])))) + ' non-idle samples per run)' if have_first else ''}; 2-3: samples of 3 later repetitions ({avg(reference, lambda r: r['phase'][phase]['steady']['samples']):.0f}/{avg(subject, lambda r: r['phase'][phase]['steady']['samples']):.0f})")
        rows = []
        for bucket in ORDER:
            steady = [avg(n, (lambda b: lambda r: r["phase"][phase]["steady"]["buckets"][b])(bucket)) for n in names]
            first = [first_buckets(n, phase)[bucket] for n in names] if have_first else [0.0] * len(names)
            rows.append((bucket, first, steady))
        for bucket, first, steady in rows:
            if any(abs(v) >= 0.005 for v in first + steady):
                print(f"   {bucket:<54}" + "".join(f"{v:{width}.3f}" for v in first) + f"{first[-1] - first[0]:{width}.3f}"
                      + "".join(f"{v:{width}.3f}" for v in steady) + f"{steady[-1] - steady[0]:{width}.3f}")
        print(f"   {'sum of buckets (main thread)':<54}" + "".join(f"{sum(r[1][i] for r in rows):{width}.3f}" for i in range(len(names))) + f"{'':{width}}"
              + "".join(f"{sum(r[2][i] for r in rows):{width}.3f}" for i in range(len(names))))
        key = 1 if have_first else 2
        print(f"\ntop {subject}-{reference} main-thread bucket differences ({'first run' if have_first else 'repetitions'}) and the frames behind them (per event, M; frame = innermost frame the bucket pattern matched):")
        for bucket, first, steady in sorted(rows, key=lambda row: -(row[key][-1] - row[key][0]))[:top_buckets]:
            values = row_values = (first if have_first else steady)
            print(f"  {bucket}: {values[-1] - values[0]:+.3f}  ({reference} {values[0]:.3f}, {subject} {values[-1]:.3f})")
            for n in (reference, subject):
                merged = first_frames(n, phase) if have_first else mean_dict([r["phase"][phase]["steady"]["frames"] for r in groups[n]])
                top = sorted(((v, k[1]) for k, v in merged.items() if k[0] == bucket), reverse=True)[:top_functions]
                print(f"     {n}: " + "; ".join(f"{v:.3f} {frame}" for v, frame in top))


if __name__ == "__main__":
    main()
