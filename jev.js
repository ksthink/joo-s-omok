// ─── Jev Intuition Layer ───────────────────────────────────────────────────────
// "Code computes, Jev judges": the MiniMax engine handles every forcing position
// (fives, fours, open threes, proven wins/losses) on its own. In quiet positions
// it hands Jev its top candidates, each already scored at one common depth, and
// the final move blends Jev's probability with the engine's score.
// Any failure (no key, timeout, bad answer) falls back to the engine's move.

const JEV_CONFIG = {
    enabled: true,
    modes: ['practice'],     // challenge levels stay pure MiniMax so scores stay comparable
    alpha: 0.4,              // weight of Jev's probability in the blend (0 = pure MiniMax)
    safetyMargin: 5000,      // drop candidates worse than the engine's best by more than this
    candidates: 8,           // how many engine candidates Jev chooses from
    timeoutMs: 2500,         // client-side cap on the /api/jev-move round trip
    retryAfterMs: 60000,     // pause after a transient failure
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
    const norm = s => (hi === lo ? 1 : (s - lo) / (hi - lo));

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
                candidates: candidates.map(c => ({ row: c.row, col: c.col, me: c.me, opp: c.opp })),
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

// Entry point used by the game. Always resolves to a legal move (or null on a full board).
async function chooseAIMove(board, timeLimit, mode, lastMove) {
    if (!jevActive(mode)) {
        if (JEV_CONFIG.enabled && JEV_CONFIG.modes.includes(mode)) {
            jevReport({ state: 'paused', error: jevStats.lastError });
        }
        return getAIMove(board, timeLimit);
    }

    const analysis = getAIMoveAnalysis(board, timeLimit, { candidates: JEV_CONFIG.candidates });
    if (analysis.forced) {
        jevReport({ state: 'forced', move: analysis.move });
        return analysis.move;
    }

    jevStats.calls++;
    jevReport({ state: 'thinking', candidates: analysis.candidates, engineMove: analysis.move });
    try {
        const data = await requestJevProbabilities(board, analysis.candidates, lastMove);
        const move = blendJevChoice(analysis.candidates, data.probabilities);
        const override = move.row !== analysis.move.row || move.col !== analysis.move.col;
        if (override) jevStats.overrides++;
        jevReport({
            state: 'done', candidates: analysis.candidates, probabilities: data.probabilities,
            confidence: data.confidence, engineMove: analysis.move, move, override,
        });
        return move;
    } catch (e) {
        jevStats.fallbacks++;
        jevStats.lastError = String(e && e.message || e);
        if (jevPausedUntil !== Infinity) jevPausedUntil = Date.now() + JEV_CONFIG.retryAfterMs;
        jevReport({ state: 'fallback', error: jevStats.lastError, move: analysis.move });
        return analysis.move;
    }
}
