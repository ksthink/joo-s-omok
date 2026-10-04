#!/usr/bin/env python3
"""Match harness: joo-s-omok ai.js vs yups1199/Gomoku-MiniMax.

usage: python3 tools/match/match.py N_OPENINGS OUR_TIME_MS OPP_DEPTH [--out FILE] [--ai PATH]

Each opening is played twice (our engine black once, white once), strictly one
game at a time. One JSON line per game is appended to the output file.
"""
import argparse
import contextlib
import io
import json
import os
import random
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(HERE, 'vendor', 'Gomoku-MiniMax')
REPO_URL = 'https://github.com/yups1199/Gomoku-MiniMax.git'
SIZE = 15
CENTER = 7
BLACK, WHITE = 1, 2


def ensure_vendor():
    if not os.path.isdir(VENDOR):
        os.makedirs(os.path.dirname(VENDOR), exist_ok=True)
        subprocess.check_call(['git', 'clone', '-q', REPO_URL, VENDOR])
    sys.path.insert(0, VENDOR)


def make_openings(n, seed=7):
    """First move (7,7), then two random moves within center +-2. N distinct openings."""
    rng = random.Random(seed)
    seen = set()
    openings = []
    tries = 0
    while len(openings) < n and tries < 100000:
        tries += 1
        moves = [(CENTER, CENTER)]
        while len(moves) < 3:
            m = (rng.randint(CENTER - 2, CENTER + 2), rng.randint(CENTER - 2, CENTER + 2))
            if m not in moves:
                moves.append(m)
        key = tuple(moves)
        if key in seen:
            continue
        seen.add(key)
        openings.append(moves)
    return openings


class JooEngine:
    def __init__(self, ai_path=None):
        env = dict(os.environ)
        if ai_path:
            env['JOO_AI_PATH'] = os.path.abspath(ai_path)
        self.proc = subprocess.Popen(
            ['node', os.path.join(HERE, 'joo_engine.js')],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1, env=env)

    def move(self, board, me, time_limit):
        req = json.dumps({'board': board, 'timeLimit': time_limit, 'me': me})
        self.proc.stdin.write(req + '\n')
        self.proc.stdin.flush()
        resp = json.loads(self.proc.stdout.readline())
        return (resp['row'], resp['col']), resp['ms']

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


class OppEngine:
    """Gomoku-MiniMax driven through its model.Game (no pygame)."""

    def __init__(self, depth):
        import settings
        import model
        self.st = settings
        self.model = model
        self.depth = depth

    def move(self, board, me):
        st = self.st
        mine, theirs = ('B', 'W') if me == BLACK else ('W', 'B')
        st.AI_COLOR, st.PLAYER_COLOR = mine, theirs
        game = self.model.Game()
        for r in range(SIZE):
            for c in range(SIZE):
                v = board[r][c]
                if v:
                    game.board[r * SIZE + c] = 'B' if v == BLACK else 'W'
        t0 = time.perf_counter()
        with contextlib.redirect_stdout(io.StringIO()):
            pos = game.best_ai_move(self.depth)
        ms = (time.perf_counter() - t0) * 1000
        return (pos[0], pos[1]), round(ms)


def five(board, r, c, color):
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        n = 1
        for s in (1, -1):
            rr, cc = r + dr * s, c + dc * s
            while 0 <= rr < SIZE and 0 <= cc < SIZE and board[rr][cc] == color:
                n += 1
                rr += dr * s
                cc += dc * s
        if n >= 5:
            return True
    return False


def play(opening, our_color, joo, opp, time_limit):
    board = [[0] * SIZE for _ in range(SIZE)]
    moves = []
    color = BLACK
    for (r, c) in opening:
        board[r][c] = color
        moves.append([r, c])
        color = 3 - color
    ms = {'joo': [], 'opp': []}
    winner = 0
    illegal = None
    while len(moves) < SIZE * SIZE:
        if color == our_color:
            (r, c), t = joo.move(board, color, time_limit)
            who = 'joo'
        else:
            (r, c), t = opp.move(board, color)
            who = 'opp'
        ms[who].append(t)
        if not (0 <= r < SIZE and 0 <= c < SIZE) or board[r][c] != 0:
            illegal = who
            winner = 3 - color
            break
        board[r][c] = color
        moves.append([r, c])
        if five(board, r, c, color):
            winner = color
            break
        color = 3 - color
    result = 'draw' if winner == 0 else ('win' if winner == our_color else 'loss')
    stat = lambda xs: (round(sum(xs) / len(xs)) if xs else 0, max(xs) if xs else 0)
    return {
        'opening': opening,
        'joo_color': 'B' if our_color == BLACK else 'W',
        'winner': {0: None, BLACK: 'B', WHITE: 'W'}[winner],
        'result': result,
        'illegal': illegal,
        'n_moves': len(moves),
        'moves': moves,
        'joo_ms_avg': stat(ms['joo'])[0], 'joo_ms_max': stat(ms['joo'])[1],
        'opp_ms_avg': stat(ms['opp'])[0], 'opp_ms_max': stat(ms['opp'])[1],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('openings', type=int)
    ap.add_argument('time_ms', type=int)
    ap.add_argument('opp_depth', type=int)
    ap.add_argument('--out', default=None)
    ap.add_argument('--ai', default=None, help='path to ai.js (default: repo ai.js)')
    ap.add_argument('--seed', type=int, default=7)
    args = ap.parse_args()

    ensure_vendor()
    out = args.out or os.path.join(
        HERE, f'match_{args.openings}_{args.time_ms}_{args.opp_depth}_{time.strftime("%Y%m%d_%H%M%S")}.jsonl')
    openings = make_openings(args.openings, args.seed)
    joo = JooEngine(args.ai)
    opp = OppEngine(args.opp_depth)
    w = l = d = 0
    try:
        with open(out, 'a') as f:
            for i, op in enumerate(openings):
                for our_color in (BLACK, WHITE):
                    rec = play(op, our_color, joo, opp, args.time_ms)
                    rec.update({'game': i * 2 + (our_color - 1), 'opening_idx': i,
                                'time_ms': args.time_ms, 'opp_depth': args.opp_depth})
                    f.write(json.dumps(rec) + '\n')
                    f.flush()
                    w += rec['result'] == 'win'
                    l += rec['result'] == 'loss'
                    d += rec['result'] == 'draw'
                    print(f"[{i * 2 + our_color}/{2 * len(openings)}] opening {i} joo={rec['joo_color']} "
                          f"{rec['result']} in {rec['n_moves']} moves "
                          f"(joo {rec['joo_ms_avg']}/{rec['joo_ms_max']}ms, opp {rec['opp_ms_avg']}/{rec['opp_ms_max']}ms)"
                          f"  total {w}-{l}-{d}", flush=True)
    finally:
        joo.close()
    print('output:', out)


if __name__ == '__main__':
    main()
