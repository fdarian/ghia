#!/usr/bin/env python3
"""Self and inclusive time by function for the samples of a .cpuprofile whose stack holds a given function (default pressKey: profile-keys.tsx's
key loop), so the mount and the settle are not in the table.
  cpuprof-window.py <file.cpuprofile> [--root pressKey] [--keys N] [--top 40] [--children FUNCTION] [--stacks FUNCTION]
--keys N     divides the times by N keys (ms per key).
--children   prints the callees of FUNCTION (by inclusive time) instead of the table.
--stacks     prints the caller chains of the samples whose leaf is FUNCTION.
"""
import argparse, collections, json, os

ap = argparse.ArgumentParser()
ap.add_argument("profile")
ap.add_argument("--root", default="pressKey")
ap.add_argument("--keys", type=int, default=1)
ap.add_argument("--top", type=int, default=40)
ap.add_argument("--children")
ap.add_argument("--stacks")
args = ap.parse_args()

data = json.load(open(args.profile))
nodes = {node["id"]: node for node in data["nodes"]}
parent = {}
for node in data["nodes"]:
    for child in node.get("children", []):
        parent[child] = node["id"]

def label(node):
    frame = node["callFrame"]
    name = frame["functionName"] or "(anonymous)"
    url = frame["url"]
    where = os.path.basename(url) if url else "native"
    line = f":{frame['lineNumber'] + 1}" if url and frame["lineNumber"] >= 0 else ""
    return f"{name} {where}{line}"

def stack(node_id):
    out = []
    while node_id in nodes:
        out.append(node_id)
        node_id = parent.get(node_id)
        if node_id is None:
            break
    return out  # leaf first

samples = data["samples"]
deltas = data["timeDeltas"]
inside = [(s, d) for s, d in zip(samples, deltas) if any(nodes[n]["callFrame"]["functionName"] == args.root for n in stack(s))]
total = sum(d for _, d in inside) / 1000.0
per = args.keys
print(f"{len(inside)} samples of {len(samples)} hold {args.root}: {total:.1f} ms, {total / per:.3f} ms per key")

selfms = collections.Counter()
inclms = collections.Counter()
for s, d in inside:
    chain = stack(s)
    selfms[label(nodes[s])] += d / 1000.0
    for key in {label(nodes[n]) for n in chain}:
        inclms[key] += d / 1000.0

if args.children:
    kids = collections.Counter()
    for s, d in inside:
        chain = stack(s)
        for i, n in enumerate(chain):
            if nodes[n]["callFrame"]["functionName"] == args.children and i > 0:
                kids[label(nodes[chain[i - 1]])] += d / 1000.0
                break
    for key, ms in kids.most_common(args.top):
        print(f"{ms / per:8.3f} ms/key  {key}")
elif args.stacks:
    chains = collections.Counter()
    for s, d in inside:
        if nodes[s]["callFrame"]["functionName"] == args.stacks:
            chains[" < ".join(label(nodes[n]) for n in stack(s)[:7])] += d / 1000.0
    for key, ms in chains.most_common(args.top):
        print(f"{ms / per:8.3f} ms/key  {key}")
else:
    print("\nself ms/key")
    for key, ms in selfms.most_common(args.top):
        print(f"{ms / per:8.3f}  {100 * ms / total:5.1f}%  {key}")
    print("\ninclusive ms/key")
    for key, ms in inclms.most_common(args.top):
        print(f"{ms / per:8.3f}  {100 * ms / total:5.1f}%  {key}")
