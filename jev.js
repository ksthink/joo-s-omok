// ─── Jev Intuition Layer ───────────────────────────────────────────────────────
// "Code computes, Jev judges": the engine handles every forcing position (fives,
// fours, open threes, proven wins/losses) on its own. In quiet positions it hands
// Jev its top candidates and the final move blends Jev's probability with the
// engine's score. The engine is Rapfi (rapfi.js) once it has loaded, otherwise
// the built-in MiniMax. Any failure (no key, timeout, bad answer) falls back to
// the engine's move.

const JEV_CONFIG = {
    enabled: true,
    modes: ['practice'],     // challenge levels stay pure MiniMax so scores stay comparable
    alpha: 0.4,              // weight of Jev's probability in the blend (0 = pure MiniMax)
    safetyMargin: 5000,      // drop candidates worse than the engine's best by more than this
    candidates: 8,           // how many engine candidates Jev chooses from
    timeoutMs: 2500,         // client-side cap on the /api/jev-move round trip
    retryAfterMs: 60000,     // pause after a transient failure
    // With the Rapfi engine, candidate scores are win rates (0..1):
    rapfiSafetyMargin: 0.10, // drop candidates more than 10 points of win rate below the best
};

const jevStats = { calls: 0, overrides: 0, fallbacks: 0, lastError: null };
let jevPausedUntil = 0;

// Optional UI hook: receives { state, ... } at each step of an AI move in a Jev mode.
// state: 'thinking' | 'done' | 'forced' | 'fallback' | 'paused'
let jevListener = null;

function jevReport(info) {
    if (!jevListener) return;
    try { jevListener(info); } catch (e) { /* the overlay must never break a move */ }
}

function jevActive(mode) {
    return JEV_CONFIG.enabled && JEV_CONFIG.modes.includes(mode) && Date.now() >= jevPausedUntil;
}

// Combine engine scores and Jev probabilities. Pure function, exported for tests.
// candidates: [{row, col, score}] with the engine's best first.
// probs: [{row, col, p}] from Jev. Returns the chosen {row, col}.
function blendJevChoice(candidates, probs, opts) {
    opts = opts || JEV_CONFIG;
    const best = candidates[0];
    const safe = candidates.filter(c => c.score >= best.score - opts.safetyMargin);
    if (safe.length < 2) return { row: best.row, col: best.col };

    const pOf = c => {
        const hit = probs.find(p => p.row === c.row && p.col === c.col);
        return hit ? hit.p : 0;
    };
    const scores = safe.map(c => c.score);
    const lo = Math.min(...scores), hi = Math.max(...scores);
    // Engine score on a 0..1 scale: min-max over the safe set, or (Rapfi win rates)
    // distance from the best as a share of the margin, so near-equal moves stay near-equal
    const norm = opts.marginScale
        ? s => 1 - (best.score - s) / opts.safetyMargin
        : s => (hi === lo ? 1 : (s - lo) / (hi - lo));

    let pick = safe[0], pickValue = -Infinity;
    for (const c of safe) {
        const value = opts.alpha * pOf(c) + (1 - opts.alpha) * norm(c.score);
        if (value > pickValue) { pickValue = value; pick = c; }
    }
    return { row: pick.row, col: pick.col };
}

async function requestJevProbabilities(board, candidates, lastMove) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JEV_CONFIG.timeoutMs);
    try {
        const res = await fetch('/api/jev-move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: ctrl.signal,
            body: JSON.stringify({
                board,
                lastMove,
                candidates: candidates.map(c => ({ row: c.row, col: c.col, me: c.me, opp: c.opp, winrate: c.winrate })),
            }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data || !data.ok) {
            const err = (data && data.error) || `http_${res.status}`;
            // No key configured on the server: stop asking for this session
            if (err === 'jev_disabled' || res.status === 404) jevPausedUntil = Infinity;
            throw new Error(err);
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// Candidates from the Rapfi engine, shaped like getAIMoveAnalysis() output.
// `forced` when there is nothing for Jev to judge: a proven win or loss, or fewer
// than two candidates within the safety margin of the best.
async function rapfiAnalysis(board) {
    const res = await rapfiThink(board, RAPFI_CONFIG.timeMs, RAPFI_CONFIG.candidates);
    const candidates = res.candidates.map(c => {
        const shape = describeMoveThreats(board, c.row, c.col);
        return { row: c.row, col: c.col, score: c.winrate, winrate: c.winrate, mate: c.mate, me: shape.me, opp: shape.opp };
    });
    const best = candidates[0];
    const safe = best ? candidates.filter(c => c.score >= best.score - JEV_CONFIG.rapfiSafetyMargin) : [];
    const forced = !best || best.mate != null || safe.length < 2;
    return { move: res.move, forced, candidates, depth: res.depth, engine: 'rapfi', winrate: best ? best.winrate : null };
}

// Entry point used by the game. Always resolves to a legal move (or null on a full board).
// Engine: Rapfi when it is loaded for this mode, otherwise the built-in MiniMax.
async function chooseAIMove(board, timeLimit, mode, lastMove) {
    const jevMode = JEV_CONFIG.enabled && JEV_CONFIG.modes.includes(mode);
    let analysis = null;

    if (typeof rapfiActive === 'function' && rapfiActive(mode) && rapfiReady()) {
        try {
            analysis = await rapfiAnalysis(board);
        } catch (e) {
            analysis = null; // engine failed: the built-in engine takes over below
        }
    }
    const blendOpts = analysis
        ? { alpha: JEV_CONFIG.alpha, safetyMargin: JEV_CONFIG.rapfiSafetyMargin, marginScale: true }
        : JEV_CONFIG;

    if (!jevActive(mode)) {
        if (jevMode) jevReport({ state: 'paused', error: jevStats.lastError, analysis });
        return analysis ? analysis.move : getAIMove(board, timeLimit);
    }

    if (!analysis) analysis = getAIMoveAnalysis(board, timeLimit, { candidates: JEV_CONFIG.candidates });
    if (analysis.forced) {
        jevReport({ state: 'forced', move: analysis.move, analysis });
        return analysis.move;
    }

    jevStats.calls++;
    jevReport({ state: 'thinking', candidates: analysis.candidates, engineMove: analysis.move, analysis });
    try {
        const data = await requestJevProbabilities(board, analysis.candidates, lastMove);
        const move = blendJevChoice(analysis.candidates, data.probabilities, blendOpts);
        const override = move.row !== analysis.move.row || move.col !== analysis.move.col;
        if (override) jevStats.overrides++;
        jevReport({
            state: 'done', candidates: analysis.candidates, probabilities: data.probabilities,
            confidence: data.confidence, outcome: data.outcome || null,
            engineMove: analysis.move, move, override, analysis, safetyMargin: blendOpts.safetyMargin,
        });
        return move;
    } catch (e) {
        jevStats.fallbacks++;
        jevStats.lastError = String(e && e.message || e);
        if (jevPausedUntil !== Infinity) jevPausedUntil = Date.now() + JEV_CONFIG.retryAfterMs;
        jevReport({ state: 'fallback', error: jevStats.lastError, move: analysis.move, analysis });
        return analysis.move;
    }
}
