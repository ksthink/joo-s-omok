// ─── Rapfi Engine Worker ───────────────────────────────────────────────────────
// Runs the Rapfi WebAssembly engine (rapfi/, GPL-3.0, see rapfi/README.md) off
// the main thread and speaks its Gomocup / Yixin-Board text protocol.
//
// Messages in:  { type: 'init' }
//               { type: 'think', id, stones: [{row, col, own}], timeMs, nbest }
// Messages out: { type: 'loading', progress }            0..1 while rapfi.data downloads
//               { type: 'ready' } | { type: 'error', error }
//               { type: 'result', id, move, candidates, depth }
//   candidates: [{row, col, winrate, eval, mate, line}] best first, winrate for the
//   side to move (0..1); mate is +n / -n when the engine sees a forced win / loss.

const RAPFI_DIR = 'rapfi/';
const RAPFI_BOARD_SIZE = 15;

// Collects the engine's multi-PV output for one search. Pure, used by tests.
function createRapfiParser() {
    const pvs = new Map(); // PV index -> latest finished report
    let current = null, depth = 0;

    function parseEval(text) {
        const mate = /^([+-])M(\d+)$/.exec(text);
        if (mate) return { eval: null, mate: (mate[1] === '+' ? 1 : -1) * Number(mate[2]) };
        return { eval: Number(text), mate: null };
    }

    return {
        // Returns the final move {row, col} when `line` is the engine's answer, else null.
        feed(line) {
            const move = /^(\d+),(\d+)$/.exec(line);
            if (move) return { row: Number(move[2]), col: Number(move[1]) };

            const info = /^INFO (\w+) (.*)$/.exec(line);
            if (!info) return null;
            const key = info[1], value = info[2];
            if (key === 'PV') {
                if (value === 'DONE') {
                    if (current && current.line.length) pvs.set(current.index, current);
                    current = null;
                } else {
                    current = { index: Number(value), winrate: null, eval: null, mate: null, line: [], depth: 0 };
                }
            } else if (current) {
                if (key === 'DEPTH') { current.depth = Number(value); depth = Math.max(depth, current.depth); }
                else if (key === 'EVAL') Object.assign(current, parseEval(value));
                else if (key === 'WINRATE') current.winrate = Number(value);
                else if (key === 'BESTLINE') {
                    current.line = (value.match(/\d+,\d+/g) || []).map(s => {
                        const [x, y] = s.split(',').map(Number);
                        return { row: y, col: x };
                    });
                }
            }
            return null;
        },

        // Candidates for the finished search: `move` first, then by win rate.
        result(move) {
            const seen = new Set();
            const candidates = [];
            for (const pv of pvs.values()) {
                const first = pv.line[0];
                const id = first.row * RAPFI_BOARD_SIZE + first.col;
                if (seen.has(id)) continue;
                seen.add(id);
                let winrate = pv.winrate;
                if (pv.mate != null) winrate = pv.mate > 0 ? 1 : 0;
                if (winrate == null || Number.isNaN(winrate)) continue;
                candidates.push({ row: first.row, col: first.col, winrate, eval: pv.eval, mate: pv.mate, line: pv.line });
            }
            const isMove = c => c.row === move.row && c.col === move.col;
            candidates.sort((a, b) => (isMove(b) - isMove(a)) || (b.winrate - a.winrate));
            return { move, candidates, depth };
        },
    };
}

// Protocol commands for one search. `own` stones belong to the side to move.
// The engine replays YXBOARD stones as a move sequence, so they are sent in
// alternating order ending with the opponent's stone; any other order makes it
// evaluate the position for the wrong side.
function rapfiThinkCommands(stones, timeMs, nbest) {
    const own = stones.filter(s => s.own), opp = stones.filter(s => !s.own);
    const first = opp.length > own.length ? opp : own;
    const second = first === opp ? own : opp;
    const ordered = [];
    for (let i = 0; i < Math.max(first.length, second.length); i++) {
        if (i < first.length) ordered.push(first[i]);
        if (i < second.length) ordered.push(second[i]);
    }
    const board = ordered.map(s => `${s.col},${s.row},${s.own ? 1 : 2}`).join(' ');
    return [
        `INFO TIMEOUT_TURN ${Math.max(50, Math.round(timeMs))}`,
        `YXBOARD ${board} DONE`,
        `YXNBEST ${Math.max(1, nbest || 1)}`,
    ];
}

const RAPFI_SETUP_COMMANDS = [
    `START ${RAPFI_BOARD_SIZE}`,
    'INFO RULE 0',                 // freestyle: five or more in a row wins
    'INFO THREAD_NUM 1',
    'INFO HASH_SIZE 32768',        // KiB
    'INFO TIMEOUT_MATCH 100000000',
    'INFO TIME_LEFT 100000000',
    'INFO MAX_DEPTH 100',
    'INFO MAX_NODE 0',
    'INFO SHOW_DETAIL 2',
    'INFO PONDERING 0',
];

// WebAssembly SIMD support (a v128 constant in a tiny module)
function rapfiHasSimd() {
    try {
        return WebAssembly.validate(new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
            65, 0, 253, 15, 253, 98, 11,
        ]));
    } catch (e) {
        return false;
    }
}

if (typeof importScripts === 'function') {
    let engine = null, parser = null, activeId = null, ready = false;

    const onStdout = line => {
        if (!parser) return;
        const move = parser.feed(line);
        if (move) {
            self.postMessage(Object.assign({ type: 'result', id: activeId }, parser.result(move)));
            parser = null;
        }
    };

    const onStatus = status => {
        if (ready) return;
        const m = /\((\d+)\/(\d+)\)/.exec(status || '');
        if (m) self.postMessage({ type: 'loading', progress: Number(m[1]) / Number(m[2]) });
    };

    self.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'init') {
            const base = new URL(RAPFI_DIR, self.location.href).href;
            const name = rapfiHasSimd() ? 'rapfi-single-simd128' : 'rapfi-single';
            try {
                importScripts(base + name + '.js');
                self.Rapfi({
                    locateFile: url => base + (/^rapfi.*\.data$/.test(url) ? 'rapfi.data' : url),
                    onReceiveStdout: onStdout,
                    onReceiveStderr: () => {},
                    onExit: code => self.postMessage({ type: 'error', error: 'engine exited: ' + code }),
                    setStatus: onStatus,
                }).then(instance => {
                    engine = instance;
                    for (const cmd of RAPFI_SETUP_COMMANDS) engine.sendCommand(cmd);
                    ready = true;
                    self.postMessage({ type: 'ready', build: name });
                }).catch(err => self.postMessage({ type: 'error', error: String(err && err.message || err) }));
            } catch (err) {
                self.postMessage({ type: 'error', error: String(err && err.message || err) });
            }
        } else if (msg.type === 'think' && engine) {
            activeId = msg.id;
            parser = createRapfiParser();
            for (const cmd of rapfiThinkCommands(msg.stones, msg.timeMs, msg.nbest)) engine.sendCommand(cmd);
        }
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createRapfiParser, rapfiThinkCommands, RAPFI_SETUP_COMMANDS };
}
