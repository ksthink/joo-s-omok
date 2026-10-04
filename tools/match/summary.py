#!/usr/bin/env python3
"""Summarise match JSONL files: python3 tools/match/summary.py FILE [FILE...]"""
import json
import math
import sys
from collections import Counter


def wilson(k, n, z=1.96):
    if n == 0:
        return 0.0, 0.0
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return centre - half, centre + half


def line(label, recs):
    n = len(recs)
    w = sum(r['result'] == 'win' for r in recs)
    l = sum(r['result'] == 'loss' for r in recs)
    d = sum(r['result'] == 'draw' for r in recs)
    lo, hi = wilson(w, n)
    rate = 100 * w / n if n else 0
    return f"{label:<10} {n:>4} games  {w:>3}W {l:>3}L {d:>2}D  win {rate:5.1f}%  (95% CI {100 * lo:5.1f}-{100 * hi:5.1f}%)"


def main(paths):
    recs = []
    for p in paths:
        with open(p) as f:
            recs += [json.loads(x) for x in f if x.strip()]
    if not recs:
        print('no games')
        return
    print(line('total', recs))
    print(line('joo black', [r for r in recs if r['joo_color'] == 'B']))
    print(line('joo white', [r for r in recs if r['joo_color'] == 'W']))
    dup = Counter(tuple(map(tuple, r['moves'])) for r in recs)
    print(f"duplicate games: {sum(c - 1 for c in dup.values() if c > 1)}")
    illegal = Counter(r['illegal'] for r in recs if r.get('illegal'))
    if illegal:
        print('illegal moves:', dict(illegal))
    n = len(recs)
    print(f"avg moves/game: {sum(r['n_moves'] for r in recs) / n:.1f}")
    jw = sum(r['joo_ms_avg'] for r in recs) / n
    ow = sum(r['opp_ms_avg'] for r in recs) / n
    print(f"joo ms/move: avg {jw:.0f}, max {max(r['joo_ms_max'] for r in recs)}")
    print(f"opp ms/move: avg {ow:.0f}, max {max(r['opp_ms_max'] for r in recs)}")
    tl = recs[0].get('time_ms')
    if tl:
        over = sum(r['joo_ms_max'] > tl * 1.1 for r in recs)
        print(f"games with a joo move over 110% of {tl}ms: {over}")


if __name__ == '__main__':
    main(sys.argv[1:])
