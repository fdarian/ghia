#!/usr/bin/env python3
"""Buckets the main thread's samples under `draw_frame` of a `sample` file (sample-frame.sh) and prints, scaled to M instructions per frame:
 1. the phase of the frame (Window::draw: build = GpuixView::render, request_layout, taffy compute, prepaint, paint, end_frame, other), each split
    into text layout (shaping and line-layout cache lookups, Ghia's text planning), text paint (glyphs) and everything else;
 2. the named subsystems (innermost frame of the stack that a pattern matches; malloc, free and memmove fall through to their caller);
 3. the top native functions by self samples.
  python3 sample-report.py <frame M> <sample file>... [--top N]
`frame M` is the instructions of the frame the samples are of (profile.tsx's `frame`); samples are time, not instructions, so a share is an
estimate of the instruction share. A toggle's samples are the mount frame and the (small) unmount frame together.
Release symbols are not stripped, but LTO folds identical functions (`<deduplicated_symbol>`) and inlines, so the names are approximate:
the phase table (Window::draw's own callees) is the reliable one.
"""
import re
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
LINE = re.compile(r"^([ +!:|]*?)(\d+) (.*)$")


def readable(frame):
    frame = re.sub(r"\s+\(in [^)]*\).*$", "", frame)
    frame = re.sub(r"\s+\+\s+\d+\s+\[0x[0-9a-f]+\]$", "", frame)
    if not frame.startswith("_R"):
        return frame[:100]
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
    return "::".join(identifiers[-4:]) if identifiers else frame[:100]


def main_thread_leaves(path):
    """(self count, [frame names root to leaf]) of every stack of the main thread."""
    lines = open(path, errors="replace").read().split("\n")
    stack, items, inside = [], [], False
    for line in lines:
        if re.match(r"^    \d+ Thread_", line):
            inside = bool(re.search(r"main-thread|Main Thread", line))
            stack = []
            continue
        if line.startswith("Total number in stack"):
            break
        if not inside:
            continue
        m = LINE.match(line)
        if not m:
            continue
        depth, count, name = len(m.group(1)), int(m.group(2)), m.group(3)
        while stack and stack[-1]["depth"] >= depth:
            stack.pop()
        node = {"depth": depth, "count": count, "name": name, "kids": 0}
        if stack:
            stack[-1]["kids"] += count
        stack.append(node)
        items.append((node, [n["name"] for n in stack]))
    for node, names in items:
        own = node["count"] - node["kids"]
        if own > 0:
            yield own, names


# In priority order: the first phase with a frame anywhere in the stack (GpuixView::render runs inside AnyView::request_layout, so the
# request_layout pattern must come after it).
PHASES = [
    ("end_frame (taffy collect_garbage)", r"end_frame|collect_garbage"),
    ("build: GpuixView::render / build_element", r"^render::.*GpuixView$|Render::render|build_element|build_plan|build_content"),
    ("taffy compute_layout (flex, measure callbacks; a patch's lay_out_again)", r"compute_layout_in|run_taffy_in"),
    ("request_layout (gpui Div/Text/Retained: layout nodes)", r"request_layout"),
    ("prepaint (hitboxes, retained prepaint)", r"prepaint"),
    ("paint (scene, glyphs, retained paint)", r"(?<![A-Za-z])paint|paint_with|Element::paint"),
]
TEXT_LAYOUT = re.compile(r"shape_text_inline|min_content_width_inline|line_layout|shape_store|resolve_font|font_id|text_system::Font|WrappedLine|line_rows|plan_cache|text::inline|paragraph_content|plan_flow|plan_children|Text::layout|text::_10Text::layout|elements::text.*(layout)")
TEXT_PAINT = re.compile(r"paint_line|paint_glyph|paint_pending_glyph|glyph_tile|raster_bounds|selectable_text|elements::text.*paint|push_decoration")
SUBSYSTEMS = [
    ("text: shaping and line-layout cache (text_system, shape_store, line_layout)", r"shape_text_inline|min_content_width_inline|line_layout|shape_store|resolve_font|font_id|text_system::Font|WrappedLine|line_rows|text_system::"),
    ("text: Ghia planning (plan_cache, inline plan, paragraph_content)", r"plan_cache|text::inline|paragraph_content|plan_flow|plan_children|push_text"),
    ("text: element layout and measure (elements::text)", r"Text::layout|elements::text.*layout|selectable_text.*req"),
    ("text: glyph paint (paint_line, paint_glyph, atlas)", r"paint_line|paint_glyph|paint_pending_glyph|glyph_tile|raster_bounds|push_decoration|selectable_text|elements::text"),
    ("retained: record and replay (tape, relocation, replay_translated)", r"tape|retained|end_relocation|replay_translated|PaintOperation|Recorded|PaintRecord|finish_prepaint_recording|retain::"),
    ("scene: insert quads and primitives, layers", r"scene::|insert_quad|insert_primitive|route_within|push_layer"),
    ("hitboxes, bounds recording (insert_hitbox, record_bounds, insert_bounds)", r"insert_hitbox|record_bounds|insert_bounds|layout_bounds|automation::|ElementBounds|Hitbox"),
    ("taffy: flex compute (taffy::compute, MeasureState, resolve_linear)", r"taffy::compute|run_taffy_in|MeasureState|resolve_linear|LayoutInput|collect_flex_lines|taffy::tree|tree::cache"),
    ("taffy: node create, keyed_layout, garbage (gpui::taffy)", r"new_measured_node|keyed_layout|collect_garbage|gpui::taffy|request_measured|request_layout::_5taffy"),
    ("Ghia style resolve and apply", r"resolved_style|animate_style|style_cache|compute_style_internal|to_taffy|refine|Refineable|css::|style::"),
    ("Ghia build_element (renderer::build_*, div::new, Stateful, AnyElement)", r"renderer::|elements::div::div|Stateful|AnyElement|Interactivity"),
    ("div/element paint and request_layout glue (gpui elements::div)", r"elements::div|Div::|element::"),
]
SUB_COMPILED = [(name, re.compile(pattern)) for name, pattern in SUBSYSTEMS]
LIBC = re.compile(r"^_?(malloc|free|realloc|platform_memmove|platform_memset|xzm|_xzm)|memmove|memcpy|_malloc_zone|_tlv_get_addr|DYLD-STUB|drop_glue|ops::drop|alloc::|RawVec|raw_vec|reserve")


def classify_phase(names):
    names = [readable(n) for n in names]
    cut = max((i for i, n in enumerate(names) if n.endswith("Win::draw")), default=-1)
    rest = names[cut + 1:] if cut >= 0 else names
    for label, pattern in PHASES:
        if any(re.search(pattern, name) for name in rest):
            return label, rest
    return "other (Window::draw itself, paint_if_dirty, arena)", rest


def kind(rest):
    for name in reversed(rest):
        if TEXT_LAYOUT.search(name):
            return "text layout"
        if TEXT_PAINT.search(name):
            return "text paint"
    return "rest"


def subsystem(rest):
    for name in reversed(rest):
        if LIBC.search(name):
            continue
        for label, pattern in SUB_COMPILED:
            if pattern.search(name):
                return label
    return "unattributed"


def analyse(path):
    phase_kind, subs, selfs, libc = Counter(), Counter(), Counter(), Counter()
    total = 0
    for count, names in main_thread_leaves(path):
        if not any("draw_frame_c_callback" in n for n in names):
            continue
        phase, rest = classify_phase(names)
        phase_kind[(phase, kind(rest))] += count
        subs[subsystem(rest)] += count
        leaf = readable(names[-1])
        selfs[leaf] += count
        if LIBC.search(leaf):
            libc[leaf] += count
        total += count
    return total, phase_kind, subs, selfs, libc


def main():
    args = sys.argv[1:]
    top = 25
    if "--top" in args:
        index = args.index("--top")
        top = int(args[index + 1])
        del args[index:index + 2]
    frame_m = float(args[0])
    paths = args[1:]
    runs = [analyse(path) for path in paths]
    n = len(runs)
    mean = lambda picker: Counter({k: sum(picker(r)[k] / r[0] for r in runs) / n for k in set().union(*[picker(r).keys() for r in runs])})
    phase_kind, subs, selfs, libc = (mean(lambda r: r[1]), mean(lambda r: r[2]), mean(lambda r: r[3]), mean(lambda r: r[4]))
    print(f"samples under draw_frame: {', '.join(str(r[0]) for r in runs)} ({n} file(s)); shares are the mean over files, scaled to a {frame_m} M instruction frame")
    phases = sorted({p for p, _ in phase_kind}, key=lambda p: -sum(v for (q, _), v in phase_kind.items() if q == p))
    print(f"\n{'phase':62} {'total':>14} {'text layout':>12} {'text paint':>11} {'rest':>8}   (M instr, share)")
    for phase in phases:
        cells = {k: phase_kind[(phase, k)] for k in ("text layout", "text paint", "rest")}
        whole = sum(cells.values())
        print(f"{phase:62} {whole * frame_m:6.2f} {whole * 100:4.1f}% {cells['text layout'] * frame_m:9.2f} {cells['text paint'] * frame_m:10.2f} {cells['rest'] * frame_m:8.2f}")
    tl = sum(v for (_, k), v in phase_kind.items() if k == "text layout")
    tp = sum(v for (_, k), v in phase_kind.items() if k == "text paint")
    print(f"{'all':62} {frame_m:6.2f} 100.0% {tl * frame_m:9.2f} {tp * frame_m:10.2f} {(1 - tl - tp) * frame_m:8.2f}")
    print(f"\n{'subsystem (innermost named frame; libc falls through)':80} {'M instr':>8} {'share':>6}")
    for name, share in sorted(subs.items(), key=lambda kv: -kv[1]):
        print(f"{name:80} {share * frame_m:8.2f} {share * 100:5.1f}%")
    print(f"\nlibc self (malloc, free, realloc, memmove, memcpy, drops): {sum(libc.values()) * frame_m:.2f} M ({sum(libc.values()) * 100:.1f}%), of which " + ", ".join(f"{k} {v * 100:.1f}%" for k, v in libc.most_common(4)))
    print(f"\ntop {top} native functions by self samples:")
    for name, share in selfs.most_common(top):
        print(f"{share * frame_m:7.2f} M {share * 100:5.1f}%  {name}")


main()
