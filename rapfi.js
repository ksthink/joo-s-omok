// ─── Rapfi Engine Client ───────────────────────────────────────────────────────
// Main-thread side of rapfi-worker.js. The engine (about 40 MB with its network)
// loads in the background the first time practice mode starts; until it is ready,
// or if it fails, the built-in MiniMax engine keeps playing.

const RAPFI_CONFIG = {
    enabled: true,
    modes: ['practice'],   // challenge levels keep the built-in engine so scores stay comparable
    timeMs: 700,           // thinking time per move
    candidates: 6,         // how many of its best moves the engine reports
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
// does not answer in time.
function rapfiThink(board, timeMs, nbest) {
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
        rapfiWorker.postMessage({ type: 'think', id, stones, timeMs, nbest });
    });
    const result = rapfiQueue.then(run, run);
    rapfiQueue = result.catch(() => {});
    return result;
}
