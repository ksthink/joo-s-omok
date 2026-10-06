// ─── Rapfi Engine Client ───────────────────────────────────────────────────────
// Main-thread side of rapfi-worker.js. The engine (about 40 MB with its network)
// loads in the background the first time a game starts; until it is ready, or
// if it fails, the built-in MiniMax engine keeps playing.

const RAPFI_CONFIG = {
    enabled: true,
    modes: ['practice', 'challenge'],
    timeMs: 700,           // thinking time per move (practice)
    candidates: 6,         // how many of its best moves the engine reports (practice)
};

// Challenge strength per level. The engine searches at most `depth` plies for
// `timeMs`, reports its best `nbest` moves, and the AI plays a random one whose
// win rate is within `tolerance` of the best; with probability `blunder` it
// plays any of the reported moves instead. An immediate five, its own or the
// opponent's, is never left to chance (see rapfiPickMove).
const RAPFI_LEVELS = {
    1:  { depth: 1,   timeMs: 150,  nbest: 8, tolerance: 0.35, blunder: 0.35 },
    2:  { depth: 2,   timeMs: 150,  nbest: 8, tolerance: 0.25, blunder: 0.22 },
    3:  { depth: 2,   timeMs: 200,  nbest: 7, tolerance: 0.20, blunder: 0.18 },
    4:  { depth: 3,   timeMs: 250,  nbest: 6, tolerance: 0.12, blunder: 0.10 },
    5:  { depth: 4,   timeMs: 300,  nbest: 6, tolerance: 0.12, blunder: 0.08 },
    6:  { depth: 5,   timeMs: 350,  nbest: 5, tolerance: 0.07, blunder: 0.04 },
    7:  { depth: 6,   timeMs: 400,  nbest: 4, tolerance: 0.05, blunder: 0.03 },
    8:  { depth: 8,   timeMs: 500,  nbest: 3, tolerance: 0.03, blunder: 0.01 },
    9:  { depth: 10,  timeMs: 700,  nbest: 2, tolerance: 0.01, blunder: 0 },
    10: { depth: 100, timeMs: 2000, nbest: 1, tolerance: 0,    blunder: 0 },   // full strength
};

const rapfiState = { status: 'idle', progress: 0, error: null, build: null }; // idle | loading | ready | failed
let rapfiWorker = null;
let rapfiListener = null;   // optional UI hook: called with rapfiState on every change
let rapfiPending = null;    // { id, resolve, reject } for the search in flight
let rapfiQueue = Promise.resolve();
let rapfiSerial = 0;

function rapfiNotify() {
    if (!rapfiListener) return;
    try { rapfiListener(rapfiState); } catch (e) { /* UI errors must not break the engine */ }
}

function rapfiFail(error) {
    rapfiState.status = 'failed';
    rapfiState.error = String(error);
    if (rapfiPending) { rapfiPending.reject(new Error(rapfiState.error)); rapfiPending = null; }
    if (rapfiWorker) { rapfiWorker.terminate(); rapfiWorker = null; }
    rapfiNotify();
}

function rapfiActive(mode) {
    return RAPFI_CONFIG.enabled && RAPFI_CONFIG.modes.includes(mode);
}

function rapfiReady() {
    return rapfiState.status === 'ready';
}

// Start downloading and compiling the engine. Safe to call repeatedly.
function rapfiLoad() {
    if (rapfiState.status !== 'idle' || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return;
    rapfiState.status = 'loading';
    rapfiNotify();
    try {
        rapfiWorker = new Worker('rapfi-worker.js');
    } catch (e) {
        rapfiFail(e && e.message || e);
        return;
    }
    rapfiWorker.onerror = e => rapfiFail(e && e.message || 'worker error');
    rapfiWorker.onmessage = e => {
        const msg = e.data;
        if (msg.type === 'loading') {
            rapfiState.progress = msg.progress;
            rapfiNotify();
        } else if (msg.type === 'ready') {
            rapfiState.status = 'ready';
            rapfiState.progress = 1;
            rapfiState.build = msg.build;
            rapfiNotify();
        } else if (msg.type === 'error') {
            rapfiFail(msg.error);
        } else if (msg.type === 'result' && rapfiPending && msg.id === rapfiPending.id) {
            const pending = rapfiPending;
            rapfiPending = null;
            pending.resolve({ move: msg.move, candidates: msg.candidates, depth: msg.depth });
        }
    };
    rapfiWorker.postMessage({ type: 'init' });
}

// Ask the engine for the AI's (player 2) move on `board`. Searches run one at a time.
// Resolves to { move, candidates, depth }; rejects if the engine is unavailable or
// does not answer in time. `maxDepth` (optional) caps the search depth.
function rapfiThink(board, timeMs, nbest, maxDepth) {
    const stones = [];
    for (let r = 0; r < board.length; r++) {
        for (let c = 0; c < board.length; c++) {
            if (board[r][c] !== 0) stones.push({ row: r, col: c, own: board[r][c] === 2 });
        }
    }
    const run = () => new Promise((resolve, reject) => {
        if (!rapfiReady()) { reject(new Error('rapfi not ready')); return; }
        const id = ++rapfiSerial;
        const timer = setTimeout(() => {
            if (rapfiPending && rapfiPending.id === id) rapfiFail('engine timeout');
        }, timeMs + 5000);
        rapfiPending = {
            id,
            resolve: v => { clearTimeout(timer); resolve(v); },
            reject: e => { clearTimeout(timer); reject(e); },
        };
        rapfiWorker.postMessage({ type: 'think', id, stones, timeMs, nbest, maxDepth });
    });
    const result = rapfiQueue.then(run, run);
    rapfiQueue = result.catch(() => {});
    return result;
}

// Resolves once the engine is ready or has failed, or after `timeoutMs`; true if ready.
function rapfiWaitReady(timeoutMs) {
    if (rapfiState.status === 'ready') return Promise.resolve(true);
    if (rapfiState.status !== 'loading') return Promise.resolve(false);
    return new Promise(resolve => {
        const started = Date.now();
        const poll = () => {
            if (rapfiState.status !== 'loading' || Date.now() - started >= timeoutMs) resolve(rapfiReady());
            else setTimeout(poll, 100);
        };
        poll();
    });
}

// The move a challenge level plays from a search result (see RAPFI_LEVELS).
// Pure apart from `rand`; exported for tests. Needs findImmediateWin from ai.js.
function rapfiPickMove(board, result, level, rand) {
    rand = rand || Math.random;
    const win = findImmediateWin(board, 2) || findImmediateWin(board, 1);
    if (win) return win;
    const cands = result.candidates || [];
    if (!cands.length) return result.move;
    const best = cands[0];
    let pool = cands.filter(c => c.winrate >= best.winrate - level.tolerance);
    if (level.blunder > 0 && rand() < level.blunder) pool = cands;
    const pick = pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
    return { row: pick.row, col: pick.col };
}
