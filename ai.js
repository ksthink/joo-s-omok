// ─── AI Engine for Omok ────────────────────────────────────────────────────────
// Minimax with alpha-beta pruning, iterative deepening, Zobrist hashing,
// transposition table, killer moves, incremental evaluation,
// and bidirectional learned pattern weights (attack/defense).

// ─── Learned Weights (loaded from server) ──────────────────────────────────────
let patternWeights = null; // { attack: {pattern: weight}, defense: {pattern: weight} }

const BASE_WEIGHTS = {
    "OOOOO": 100000,
    "_OOOO_": 50000,
    "OOOO_": 10000,
    "_OOOO": 10000,
    "XOOOO_": 10000,
    "_OOOOX": 10000,
    "_OOO_": 5000,
    "OOO__": 1000,
    "__OOO": 1000,
    "_O_OO_": 1000,
    "_OO_O_": 1000,
    "OO_O_": 1000,
    "_O_OO": 1000,
    "OO__": 100,
    "__OO": 100,
    "_O_O_": 100,
    "_OO_": 100,
    "O__": 10,
    "__O": 10,
    "_O_": 10
};

// Patterns sorted by length desc then weight desc for exclusive matching
const SORTED_PATTERNS = Object.keys(BASE_WEIGHTS).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return BASE_WEIGHTS[b] - BASE_WEIGHTS[a];
});

// ─── Load Weights from Server (bidirectional: attack + defense) ────────────────
async function loadPatternWeights() {
    try {
        const response = await fetch('/api/weights');
        if (!response.ok) { patternWeights = null; return; }
        const data = await response.json();
        if (data && data.patterns) {
            patternWeights = { attack: {}, defense: {} };
            for (const [pattern, info] of Object.entries(data.patterns)) {
                patternWeights.attack[pattern] = info.attack_weight != null ? info.attack_weight : (info.weight || BASE_WEIGHTS[pattern] || 0);
                patternWeights.defense[pattern] = info.defense_weight != null ? info.defense_weight : (info.weight || BASE_WEIGHTS[pattern] || 0);
            }
        }
    } catch (e) {
        patternWeights = null;
    }
}

// perspective: 'attack' for AI stones, 'defense' for player stones
function getPatternWeight(pattern, perspective) {
    if (patternWeights && perspective && patternWeights[perspective] && patternWeights[perspective][pattern] !== undefined) {
        return patternWeights[perspective][pattern];
    }
    return BASE_WEIGHTS[pattern] || 0;
}

// ─── Game Phase Detection ──────────────────────────────────────────────────────
let currentMoveCount = 0;

function getGamePhase() {
    if (currentMoveCount <= 10) return 'opening';
    if (currentMoveCount <= 30) return 'midgame';
    return 'endgame';
}

// ─── Exclusive Pattern Matching (no double-counting) ───────────────────────────
// Matches patterns greedily by priority (longest/highest-weight first).
// Once a region of the line is matched, it cannot be matched again.
function evaluateLine(line, perspective) {
    let score = 0;
    const len = line.length;
    const matched = new Uint8Array(len); // 0 = free, 1 = matched

    for (const pattern of SORTED_PATTERNS) {
        const pLen = pattern.length;
        let idx = 0;
        while (idx <= len - pLen) {
            const found = line.indexOf(pattern, idx);
            if (found === -1) break;

            // Check if any position in [found, found+pLen) is already matched
            let overlap = false;
            for (let k = found; k < found + pLen; k++) {
                if (matched[k]) { overlap = true; break; }
            }

            if (!overlap) {
                score += getPatternWeight(pattern, perspective);
                for (let k = found; k < found + pLen; k++) matched[k] = 1;
                idx = found + pLen; // skip past matched region
            } else {
                idx = found + 1;
            }
        }
    }
    return score;
}

// ─── Zobrist Hashing (dual 32-bit for reduced collisions) ──────────────────────
const ZOBRIST_TABLE = Array.from({length: 15}, () =>
    Array.from({length: 15}, () => [
        [Math.floor(Math.random() * 0x100000000), Math.floor(Math.random() * 0x100000000)],
        [Math.floor(Math.random() * 0x100000000), Math.floor(Math.random() * 0x100000000)],
    ])
);

let zobristHashHi = 0;
let zobristHashLo = 0;

function updateZobristHash(row, col, player) {
    zobristHashHi ^= ZOBRIST_TABLE[row][col][player - 1][0];
    zobristHashLo ^= ZOBRIST_TABLE[row][col][player - 1][1];
}

function computeFullHash(board) {
    let hi = 0, lo = 0;
    for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
            if (board[i][j] !== 0) {
                hi ^= ZOBRIST_TABLE[i][j][board[i][j] - 1][0];
                lo ^= ZOBRIST_TABLE[i][j][board[i][j] - 1][1];
            }
        }
    }
    return [hi, lo];
}

function getHashKey() {
    // Combine into a single string key for Map lookup
    return zobristHashHi + '|' + zobristHashLo;
}

// ─── Transposition Table (depth-based replacement) ─────────────────────────────
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_SIZE = 500000;
const transpositionTable = new Map();

function storeTT(depth, score, move, flag) {
    const key = getHashKey();
    const existing = transpositionTable.get(key);
    // Depth-based replacement: only overwrite if new depth >= existing depth
    if (existing && existing.depth > depth) return;
    if (transpositionTable.size >= TT_MAX_SIZE && !existing) {
        // Evict oldest entries (clear half when full)
        const keys = Array.from(transpositionTable.keys());
        for (let i = 0; i < keys.length / 2; i++) {
            transpositionTable.delete(keys[i]);
        }
    }
    transpositionTable.set(key, { depth, score, move, flag });
}

function lookupTT() {
    return transpositionTable.get(getHashKey()) || null;
}

// ─── Killer Moves ──────────────────────────────────────────────────────────────
const MAX_KILLER_DEPTH = 12;
const killerMoves = Array.from({length: MAX_KILLER_DEPTH + 1}, () => [null, null]);

function updateKillerMove(depth, move) {
    if (depth <= MAX_KILLER_DEPTH && !movesEqual(killerMoves[depth][0], move)) {
        killerMoves[depth][1] = killerMoves[depth][0];
        killerMoves[depth][0] = { row: move.row, col: move.col };
    }
}

function movesEqual(a, b) {
    if (!a || !b) return false;
    return a.row === b.row && a.col === b.col;
}

// ─── Incremental Evaluation ────────────────────────────────────────────────────
// Instead of re-scanning the entire board, we maintain a running score
// and only recalculate the delta when a stone is placed or removed.

let incrementalScore = 0;

function initIncrementalScore(board) {
    incrementalScore = fullEvaluateBoard(board);
}

function calcDelta(board, row, col, player) {
    // Calculate the score contribution of placing player's stone at (row,col).
    // This affects all lines through (row,col) for both players.
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    let delta = 0;
    const perspective = player === 2 ? 'attack' : 'defense';
    const sign = player === 2 ? 1 : -1;

    // Score contribution from the newly placed stone's lines
    for (const [dr, dc] of directions) {
        const line = getLine(row, col, dr, dc, player, board);
        delta += sign * evaluateLine(line, perspective);
    }

    // Also recalc opponent lines through this point (their lines are now blocked)
    const opponent = player === 2 ? 1 : 2;
    const oppPerspective = opponent === 2 ? 'attack' : 'defense';
    const oppSign = opponent === 2 ? 1 : -1;

    for (const [dr, dc] of directions) {
        const line = getLine(row, col, dr, dc, opponent, board);
        delta += oppSign * evaluateLine(line, oppPerspective);
    }

    return delta;
}

function applyMoveIncremental(board, row, col, player) {
    // Remove old contributions from lines through this point BEFORE placing stone
    const oldDelta = calcDelta(board, row, col, player === 2 ? 1 : 2);

    board[row][col] = player;
    updateZobristHash(row, col, player);

    // Add new contributions after placing stone
    const newDelta = calcDelta(board, row, col, player);
    incrementalScore += (newDelta - oldDelta);
}

function undoMoveIncremental(board, row, col, player) {
    const oldDelta = calcDelta(board, row, col, player);

    board[row][col] = 0;
    updateZobristHash(row, col, player);

    const opponent = player === 2 ? 1 : 2;
    const newDelta = calcDelta(board, row, col, opponent);
    incrementalScore -= (oldDelta - newDelta);
}

// ─── Full Board Evaluation (used for initialization) ───────────────────────────
function fullEvaluateBoard(board) {
    const size = board.length;
    let score = 0;

    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] === 2) {
                score += evaluatePoint(i, j, 2, board, 'attack');
            } else if (board[i][j] === 1) {
                score -= evaluatePoint(i, j, 1, board, 'defense');
            }
        }
    }
    return score;
}

function evaluatePoint(row, col, player, board, perspective) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    let totalScore = 0;
    for (const [dr, dc] of directions) {
        const line = getLine(row, col, dr, dc, player, board);
        totalScore += evaluateLine(line, perspective);
    }
    return totalScore;
}

function getLine(row, col, dr, dc, player, board) {
    const size = board.length;
    let line = '';
    for (let k = -4; k <= 4; k++) {
        const r = row + dr * k;
        const c = col + dc * k;
        if (r < 0 || r >= size || c < 0 || c >= size) {
            line += 'X';
        } else if (board[r][c] === player) {
            line += 'O';
        } else if (board[r][c] === 0) {
            line += '_';
        } else {
            line += 'X';
        }
    }
    return line;
}

// ─── Entry Point ───────────────────────────────────────────────────────────────
function getAIMove(board, timeLimit) {
    // Count moves on board for phase detection
    currentMoveCount = 0;
    for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
            if (board[i][j] !== 0) currentMoveCount++;
        }
    }

    if (currentMoveCount === 0) {
        return { row: 7, col: 7 };
    }

    const winMove = findImmediateWin(board, 2);
    if (winMove) return winMove;

    const blockMove = findImmediateWin(board, 1);
    if (blockMove) return blockMove;

    // Reset state for new search
    transpositionTable.clear();
    for (let i = 0; i <= MAX_KILLER_DEPTH; i++) {
        killerMoves[i][0] = null;
        killerMoves[i][1] = null;
    }
    const [hi, lo] = computeFullHash(board);
    zobristHashHi = hi;
    zobristHashLo = lo;
    initIncrementalScore(board);

    return getAIMoveIterativeDeepening(board, timeLimit || 1000);
}

function getAIMoveIterativeDeepening(board, timeLimitMs) {
    const startTime = Date.now();
    let bestMove = null;
    let previousBestMove = null;

    for (let depth = 1; depth <= 10; depth++) {
        if (Date.now() - startTime > timeLimitMs * 0.8) break;
        const result = minimaxRoot(board, depth, startTime, timeLimitMs, previousBestMove);
        if (result.move) {
            bestMove = result.move;
            previousBestMove = result.move;
        }
        if (result.timeout) break;
        if (result.score >= 100000) break;
    }
    return bestMove;
}

function minimaxRoot(board, depth, startTime, timeLimitMs, previousBestMove) {
    const moves = getValidMovesSmart(board, previousBestMove, depth);
    if (moves.length === 0) return { score: 0, move: null, timeout: false };

    let bestMove = moves[0];
    let bestScore = -Infinity;

    for (const move of moves) {
        if (Date.now() - startTime > timeLimitMs) {
            return { score: bestScore, move: bestMove, timeout: true };
        }

        const savedScore = incrementalScore;
        applyMoveIncremental(board, move.row, move.col, 2);

        const result = minimax(board, depth - 1, -Infinity, Infinity, false, startTime, timeLimitMs);

        undoMoveIncremental(board, move.row, move.col, 2);
        incrementalScore = savedScore;

        if (result.timeout) {
            return { score: bestScore, move: bestMove, timeout: true };
        }

        if (result.score > bestScore) {
            bestScore = result.score;
            bestMove = move;
        }
    }

    return { score: bestScore, move: bestMove, timeout: false };
}

function minimax(board, depth, alpha, beta, isMaximizing, startTime, timeLimitMs) {
    if (Date.now() - startTime > timeLimitMs) {
        return { score: 0, move: null, timeout: true };
    }

    // Transposition table lookup
    const ttEntry = lookupTT();
    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === TT_EXACT) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
        if (ttEntry.flag === TT_LOWER) alpha = Math.max(alpha, ttEntry.score);
        if (ttEntry.flag === TT_UPPER) beta = Math.min(beta, ttEntry.score);
        if (alpha >= beta) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
    }

    // Use incremental score instead of full board scan
    const score = incrementalScore;
    if (depth === 0 || Math.abs(score) >= 100000) {
        return { score, move: null, timeout: false };
    }

    const ttBestMove = ttEntry ? ttEntry.move : null;
    const moves = getValidMovesSmart(board, ttBestMove, depth);
    if (moves.length === 0) {
        return { score: 0, move: null, timeout: false };
    }

    let bestMove = moves[0];
    const originalAlpha = alpha;

    if (isMaximizing) {
        let maxScore = -Infinity;

        for (const move of moves) {
            const savedScore = incrementalScore;
            applyMoveIncremental(board, move.row, move.col, 2);

            const result = minimax(board, depth - 1, alpha, beta, false, startTime, timeLimitMs);

            undoMoveIncremental(board, move.row, move.col, 2);
            incrementalScore = savedScore;

            if (result.timeout) return { score: maxScore, move: bestMove, timeout: true };

            if (result.score > maxScore) {
                maxScore = result.score;
                bestMove = move;
            }

            alpha = Math.max(alpha, maxScore);
            if (beta <= alpha) {
                updateKillerMove(depth, move);
                break;
            }
        }

        const flag = maxScore <= originalAlpha ? TT_UPPER : (maxScore >= beta ? TT_LOWER : TT_EXACT);
        storeTT(depth, maxScore, bestMove, flag);
        return { score: maxScore, move: bestMove, timeout: false };

    } else {
        let minScore = Infinity;

        for (const move of moves) {
            const savedScore = incrementalScore;
            applyMoveIncremental(board, move.row, move.col, 1);

            const result = minimax(board, depth - 1, alpha, beta, true, startTime, timeLimitMs);

            undoMoveIncremental(board, move.row, move.col, 1);
            incrementalScore = savedScore;

            if (result.timeout) return { score: minScore, move: bestMove, timeout: true };

            if (result.score < minScore) {
                minScore = result.score;
                bestMove = move;
            }

            beta = Math.min(beta, minScore);
            if (beta <= alpha) {
                updateKillerMove(depth, move);
                break;
            }
        }

        const flag = minScore >= beta ? TT_LOWER : (minScore <= originalAlpha ? TT_UPPER : TT_EXACT);
        storeTT(depth, minScore, bestMove, flag);
        return { score: minScore, move: bestMove, timeout: false };
    }
}

// ─── Move Ordering with Learned Weights ────────────────────────────────────────
const AI_THREAT_WEIGHT = 1.1;

function getValidMovesSmart(board, previousBestMove, depth) {
    const size = board.length;
    const candidates = [];
    const checked = new Set();

    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] !== 0) {
                for (let di = -2; di <= 2; di++) {
                    for (let dj = -2; dj <= 2; dj++) {
                        const ni = i + di;
                        const nj = j + dj;
                        const key = ni * size + nj;
                        if (ni >= 0 && ni < size && nj >= 0 && nj < size &&
                            board[ni][nj] === 0 && !checked.has(key)) {
                            checked.add(key);
                            candidates.push({ row: ni, col: nj });
                        }
                    }
                }
            }
        }
    }

    if (candidates.length === 0) return candidates;

    const scored = candidates.map(m => ({
        row: m.row,
        col: m.col,
        score: scoreMoveForOrdering(m.row, m.col, board, previousBestMove, depth)
    }));

    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, 12).map(m => ({ row: m.row, col: m.col }));
}

function scoreMoveForOrdering(row, col, board, previousBestMove, depth) {
    let score = 0;

    if (previousBestMove && previousBestMove.row === row && previousBestMove.col === col) {
        score += 1000000;
    }

    if (depth !== undefined && depth <= MAX_KILLER_DEPTH) {
        if (movesEqual(killerMoves[depth][0], { row, col })) score += 900000;
        else if (movesEqual(killerMoves[depth][1], { row, col })) score += 800000;
    }

    // Use learned weights in threat counting
    score += countThreats(row, col, 2, board) * AI_THREAT_WEIGHT;
    score += countThreats(row, col, 1, board);

    return score;
}

// ─── Threat Counting with Learned Weights ──────────────────────────────────────
function countThreats(row, col, player, board) {
    board[row][col] = player;
    let openFour = 0, openThree = 0, blockedFour = 0;

    for (const [dr, dc] of [[0,1],[1,0],[1,1],[1,-1]]) {
        const line = getLine(row, col, dr, dc, player, board);
        if (line.includes('_OOOO_')) {
            openFour++;
        } else if (line.includes('OOOO')) {
            blockedFour++;
        }
        if (line.includes('_OOO_')) openThree++;
    }

    board[row][col] = 0;

    // Use learned weights for threat values instead of hardcoded constants
    const perspective = player === 2 ? 'attack' : 'defense';
    if (openFour >= 1) return getPatternWeight('_OOOO_', perspective);
    if (blockedFour >= 1 && openThree >= 1) {
        return getPatternWeight('OOOO_', perspective) + getPatternWeight('_OOO_', perspective); // 사삼
    }
    if (openThree >= 2) return getPatternWeight('_OOO_', perspective) * 2; // 쌍삼
    return openThree * (getPatternWeight('_OOO_', perspective) * 0.6) + blockedFour * (getPatternWeight('OOOO_', perspective) * 0.1);
}

// ─── Utility Functions ─────────────────────────────────────────────────────────
function isEmpty(board) {
    for (let i = 0; i < board.length; i++) {
        for (let j = 0; j < board[i].length; j++) {
            if (board[i][j] !== 0) return false;
        }
    }
    return true;
}

function findImmediateWin(board, player) {
    const size = board.length;
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] === 0) {
                board[i][j] = player;
                const wins = checkWinSimple(i, j, player, board);
                board[i][j] = 0;
                if (wins) return { row: i, col: j };
            }
        }
    }
    return null;
}

function checkWinSimple(row, col, player, board) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    const size = board.length;

    for (const [dr, dc] of directions) {
        let count = 1;
        for (let k = 1; k < 5; k++) {
            const r = row + dr * k;
            const c = col + dc * k;
            if (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) count++;
            else break;
        }
        for (let k = 1; k < 5; k++) {
            const r = row - dr * k;
            const c = col - dc * k;
            if (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) count++;
            else break;
        }
        if (count >= 5) return true;
    }
    return false;
}

// Legacy compatibility: evaluateBoard for any external callers
function evaluateBoard(board) {
    return fullEvaluateBoard(board);
}
