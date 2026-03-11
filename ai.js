let patternWeights = null;
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

async function loadPatternWeights() {
    try {
        const response = await fetch('/api/weights');
        const data = await response.json();
        if (data && data.patterns) {
            patternWeights = {};
            for (const [pattern, info] of Object.entries(data.patterns)) {
                patternWeights[pattern] = info.weight;
            }
        }
    } catch (e) {
        patternWeights = null;
    }
}

function getPatternWeight(pattern) {
    if (patternWeights && patternWeights[pattern] !== undefined) {
        return patternWeights[pattern];
    }
    return BASE_WEIGHTS[pattern] || 0;
}

function evaluateLine(line) {
    const patterns = [
        'OOOOO', '_OOOO_', 'OOOO_', '_OOOO', 'XOOOO_', '_OOOOX',
        '_OOO_', 'OOO__', '__OOO', '_O_OO_', '_OO_O_', 'OO_O_', '_O_OO',
        'OO__', '__OO', '_O_O_', '_OO_', 'O__', '__O', '_O_'
    ];
    
    let score = 0;
    for (const pattern of patterns) {
        if (line.includes(pattern)) {
            score += getPatternWeight(pattern);
        }
    }
    return score;
}

// ─── Zobrist Hashing ───────────────────────────────────────────────────────────
const ZOBRIST_TABLE = Array.from({length: 15}, () =>
    Array.from({length: 15}, () => [
        Math.floor(Math.random() * 0x100000000),
        Math.floor(Math.random() * 0x100000000),
    ])
);

let zobristHash = 0;

function updateZobristHash(row, col, player) {
    zobristHash ^= ZOBRIST_TABLE[row][col][player - 1];
}

function computeFullHash(board) {
    let h = 0;
    for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
            if (board[i][j] !== 0) {
                h ^= ZOBRIST_TABLE[i][j][board[i][j] - 1];
            }
        }
    }
    return h;
}

// ─── Transposition Table ───────────────────────────────────────────────────────
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_SIZE = 500000;
const transpositionTable = new Map();

function storeTT(hash, depth, score, move, flag) {
    if (transpositionTable.size >= TT_MAX_SIZE) return;
    transpositionTable.set(hash, { depth, score, move, flag });
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

// ─── Entry Point ───────────────────────────────────────────────────────────────
function getAIMove(board, timeLimit) {
    if (isEmpty(board)) {
        return { row: 7, col: 7 };
    }

    const winMove = findImmediateWin(board, 2);
    if (winMove) return winMove;

    const blockMove = findImmediateWin(board, 1);
    if (blockMove) return blockMove;

    // Reset state for new search
    if (transpositionTable.size > TT_MAX_SIZE) {
        transpositionTable.clear();
    }
    for (let i = 0; i <= MAX_KILLER_DEPTH; i++) {
        killerMoves[i][0] = null;
        killerMoves[i][1] = null;
    }
    zobristHash = computeFullHash(board);

    return getAIMoveIterativeDeepening(board, timeLimit || 1000);
}

function getAIMoveIterativeDeepening(board, timeLimitMs) {
    const startTime = Date.now();
    let bestMove = null;
    let previousBestMove = null;

    for (let depth = 1; depth <= 8; depth++) {
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

        board[move.row][move.col] = 2;
        updateZobristHash(move.row, move.col, 2);

        const result = minimax(board, depth - 1, -Infinity, Infinity, false, startTime, timeLimitMs);

        board[move.row][move.col] = 0;
        updateZobristHash(move.row, move.col, 2);

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
    const ttEntry = transpositionTable.get(zobristHash);
    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === TT_EXACT) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
        if (ttEntry.flag === TT_LOWER) alpha = Math.max(alpha, ttEntry.score);
        if (ttEntry.flag === TT_UPPER) beta = Math.min(beta, ttEntry.score);
        if (alpha >= beta) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
    }

    const score = evaluateBoard(board);
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
            board[move.row][move.col] = 2;
            updateZobristHash(move.row, move.col, 2);

            const result = minimax(board, depth - 1, alpha, beta, false, startTime, timeLimitMs);

            board[move.row][move.col] = 0;
            updateZobristHash(move.row, move.col, 2);

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
        storeTT(zobristHash, depth, maxScore, bestMove, flag);
        return { score: maxScore, move: bestMove, timeout: false };

    } else {
        let minScore = Infinity;

        for (const move of moves) {
            board[move.row][move.col] = 1;
            updateZobristHash(move.row, move.col, 1);

            const result = minimax(board, depth - 1, alpha, beta, true, startTime, timeLimitMs);

            board[move.row][move.col] = 0;
            updateZobristHash(move.row, move.col, 1);

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
        storeTT(zobristHash, depth, minScore, bestMove, flag);
        return { score: minScore, move: bestMove, timeout: false };
    }
}

// Weight applied to AI threats vs player threats during move ordering (slight AI aggression bias)
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

    return scored.slice(0, 10).map(m => ({ row: m.row, col: m.col }));
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

    score += countThreats(row, col, 2, board) * AI_THREAT_WEIGHT;
    score += countThreats(row, col, 1, board);

    return score;
}

// ─── Threat Counting (composite threats: 쌍삼, 사삼) ──────────────────────────
function countThreats(row, col, player, board) {
    board[row][col] = player;
    let openFour = 0, openThree = 0, blockedFour = 0;

    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = getLine(row, col, dr, dc, player, board);
        if (line.includes('_OOOO_')) {
            openFour++;
        } else if (line.includes('OOOO')) {
            blockedFour++;
        }
        if (line.includes('_OOO_')) openThree++;
    }

    board[row][col] = 0;

    if (openFour >= 1) return 50000;
    if (blockedFour >= 1 && openThree >= 1) return 40000; // 사삼
    if (openThree >= 2) return 30000;                     // 쌍삼
    return openThree * 3000 + blockedFour * 1000;
}

// ─── Board Evaluation ──────────────────────────────────────────────────────────
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
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
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

function evaluateBoard(board) {
    const size = board.length;
    let score = 0;

    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] === 2) {
                score += evaluatePoint(i, j, 2, board);
            } else if (board[i][j] === 1) {
                score -= evaluatePoint(i, j, 1, board);
            }
        }
    }

    return score;
}

function evaluatePoint(row, col, player, board) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    let totalScore = 0;

    for (const [dr, dc] of directions) {
        const line = getLine(row, col, dr, dc, player, board);
        totalScore += evaluateLine(line);
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
