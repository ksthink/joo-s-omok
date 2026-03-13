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

const CLUSTER_PATTERNS = {
    "three_way_up": 3000,
    "three_way_down": 3000,
    "three_way_left": 3000,
    "three_way_right": 3000,
    "cross_plus": 5000,
    "cross_x": 5000,
    "corner_l_1": 2000,
    "corner_l_2": 2000,
    "corner_l_3": 2000,
    "corner_l_4": 2000,
    "t_shape_1": 2500,
    "t_shape_2": 2500
};

const CLUSTER_CONNECTION_PATTERNS = {
    "nearby_threes": 4000,
    "bridge_threat": 8000,
    "supporting_threat": 3000,
    "pincer_threat": 3500
};

let clusterWeights = null;
let clusterConnectionWeights = null;

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
    
    try {
        const response = await fetch('/api/cluster-weights');
        if (response.ok) {
            const data = await response.json();
            if (data) {
                clusterWeights = { attack: {}, defense: {} };
                clusterConnectionWeights = { attack: {}, defense: {} };
                if (data.cluster_patterns) {
                    for (const [patternId, info] of Object.entries(data.cluster_patterns)) {
                        clusterWeights.attack[patternId] = info.attack_weight || CLUSTER_PATTERNS[patternId] || 1000;
                        clusterWeights.defense[patternId] = info.defense_weight || CLUSTER_PATTERNS[patternId] || 1000;
                    }
                }
                if (data.cluster_connections) {
                    for (const [connType, info] of Object.entries(data.cluster_connections)) {
                        clusterConnectionWeights.attack[connType] = info.attack_weight || CLUSTER_CONNECTION_PATTERNS[connType] || 1000;
                        clusterConnectionWeights.defense[connType] = info.defense_weight || CLUSTER_CONNECTION_PATTERNS[connType] || 1000;
                    }
                }
            }
        }
    } catch (e) {
        clusterWeights = null;
        clusterConnectionWeights = null;
    }
}

function getClusterWeight(patternId, perspective) {
    if (clusterWeights && clusterWeights[perspective] && clusterWeights[perspective][patternId] !== undefined) {
        return clusterWeights[perspective][patternId];
    }
    return CLUSTER_PATTERNS[patternId] || 1000;
}

function getClusterConnectionWeight(connType, perspective) {
    if (clusterConnectionWeights && clusterConnectionWeights[perspective] && clusterConnectionWeights[perspective][connType] !== undefined) {
        return clusterConnectionWeights[perspective][connType];
    }
    return CLUSTER_CONNECTION_PATTERNS[connType] || 1000;
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

// Incremental evaluation: we track the board and recompute the full score at leaf nodes.
// True incremental (delta-only) is complex to keep in sync with line-based fullEvaluateBoard,
// so we use the board mutation + full eval approach only at depth=0.
// For interior nodes, we simply update the board state and rely on the score at depth=0.

function applyMoveIncremental(board, row, col, player) {
    board[row][col] = player;
    updateZobristHash(row, col, player);
    // incrementalScore is refreshed at depth=0 via fullEvaluateBoard; no delta needed here.
}

function undoMoveIncremental(board, row, col, player) {
    board[row][col] = 0;
    updateZobristHash(row, col, player);
    // incrementalScore is refreshed at depth=0 via fullEvaluateBoard; no delta needed here.
}

// Build a full-length line string along direction (dr,dc) starting at (r0,c0).
// Uses board boundaries as line ends (no fixed window).
function getFullLine(r0, c0, dr, dc, player, board) {
    const size = board.length;
    let line = '';
    // Walk from start to end of the board in this direction
    for (let r = r0, c = c0; r >= 0 && r < size && c >= 0 && c < size; r += dr, c += dc) {
        if (board[r][c] === player) line += 'O';
        else if (board[r][c] === 0) line += '_';
        else line += 'X';
    }
    return line;
}

// Score all unique lines on the board once per direction.
// Horizontal: 15 rows, Vertical: 15 cols, Diag \: top-row + left-col, Diag /: bottom-row + left-col.
function evaluateAllLines(board, player, perspective) {
    const size = board.length;
    let score = 0;

    // Horizontal lines (dr=0, dc=1) – one per row
    for (let r = 0; r < size; r++) {
        const line = getFullLine(r, 0, 0, 1, player, board);
        score += evaluateLine(line, perspective);
    }
    // Vertical lines (dr=1, dc=0) – one per col
    for (let c = 0; c < size; c++) {
        const line = getFullLine(0, c, 1, 0, player, board);
        score += evaluateLine(line, perspective);
    }
    // Diagonal \ (dr=1, dc=1) – top row + left col (excluding corner double-count)
    for (let c = 0; c < size; c++) {
        const line = getFullLine(0, c, 1, 1, player, board);
        score += evaluateLine(line, perspective);
    }
    for (let r = 1; r < size; r++) {
        const line = getFullLine(r, 0, 1, 1, player, board);
        score += evaluateLine(line, perspective);
    }
    // Diagonal / (dr=-1, dc=1) – bottom row + left col
    for (let c = 0; c < size; c++) {
        const line = getFullLine(size - 1, c, -1, 1, player, board);
        score += evaluateLine(line, perspective);
    }
    for (let r = 0; r < size - 1; r++) {
        const line = getFullLine(r, 0, -1, 1, player, board);
        score += evaluateLine(line, perspective);
    }

    return score;
}

// ─── Full Board Evaluation (used for initialization) ───────────────────────────
function fullEvaluateBoard(board) {
    let score = 0;

    // Line-based scan: each line evaluated exactly once per direction, no double-counting
    score += evaluateAllLines(board, 2, 'attack');
    score -= evaluateAllLines(board, 1, 'defense');

    score += evaluateClusterPatterns(board, 2, 'attack');
    score -= evaluateClusterPatterns(board, 1, 'defense');
    score += evaluateClusterConnections(board, 2, 'attack');
    score -= evaluateClusterConnections(board, 1, 'defense');
    
    return score;
}

// ─── Cluster Pattern Detection ──────────────────────────────────────────────────
function findClusters(board, player) {
    const size = board.length;
    const visited = Array(size).fill(null).map(() => Array(size).fill(false));
    const clusters = [];
    const directions8 = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    
    for (let startR = 0; startR < size; startR++) {
        for (let startC = 0; startC < size; startC++) {
            if (board[startR][startC] === player && !visited[startR][startC]) {
                const cluster = [];
                const stack = [[startR, startC]];
                while (stack.length > 0) {
                    const [r, c] = stack.pop();
                    if (visited[r][c]) continue;
                    visited[r][c] = true;
                    cluster.push([r, c]);
                    for (const [dr, dc] of directions8) {
                        const nr = r + dr, nc = c + dc;
                        if (0 <= nr && nr < size && 0 <= nc && nc < size) {
                            if (board[nr][nc] === player && !visited[nr][nc]) {
                                stack.push([nr, nc]);
                            }
                        }
                    }
                }
                if (cluster.length >= 3) {
                    clusters.push(cluster);
                }
            }
        }
    }
    return clusters;
}

function getClusterBounds(cluster) {
    const rows = cluster.map(p => p[0]);
    const cols = cluster.map(p => p[1]);
    return [Math.min(...rows), Math.max(...rows), Math.min(...cols), Math.max(...cols)];
}

function identifyClusterPattern(cluster, board) {
    if (cluster.length < 3) return null;
    
    const clusterSet = new Set(cluster.map(p => `${p[0]},${p[1]}`));
    const directions4 = [[0,1],[1,0],[1,1],[1,-1]];
    
    const [minR, maxR, minC, maxC] = getClusterBounds(cluster);
    const height = maxR - minR + 1;
    const width = maxC - minC + 1;
    
    const centerR = Math.round(cluster.reduce((s, p) => s + p[0], 0) / cluster.length);
    const centerC = Math.round(cluster.reduce((s, p) => s + p[1], 0) / cluster.length);
    
    const dirCounts = [0, 0, 0, 0];
    for (const [r, c] of cluster) {
        for (let i = 0; i < 4; i++) {
            const [dr, dc] = directions4[i];
            const nr = r + dr, nc = c + dc;
            if (clusterSet.has(`${nr},${nc}`)) {
                dirCounts[i]++;
            }
        }
    }
    
    const activeDirs = dirCounts.filter(c => c > 0).length;
    
    if (activeDirs >= 3) {
        if (dirCounts[0] > 0 && dirCounts[1] > 0) return 'cross_plus';
        if (dirCounts[2] > 0 && dirCounts[3] > 0) return 'cross_x';
        return 'three_way_up';
    }
    
    if (activeDirs === 2) {
        const hasV = dirCounts[1] > 0;
        const hasH = dirCounts[0] > 0;
        if (hasV && hasH) {
            if (height <= 3 && width <= 3) return 'cross_plus';
            const topMost = cluster.filter(p => p[0] === minR);
            const bottomMost = cluster.filter(p => p[0] === maxR);
            if (topMost.some(p => Math.abs(p[1] - centerC) <= 1)) return 't_shape_1';
            if (bottomMost.some(p => Math.abs(p[1] - centerC) <= 1)) return 't_shape_2';
            return 'corner_l_1';
        }
    }
    
    return null;
}

function evaluateClusterPatterns(board, player, perspective) {
    const clusters = findClusters(board, player);
    let score = 0;
    const counted = new Set();
    
    for (const cluster of clusters) {
        const patternType = identifyClusterPattern(cluster, board);
        if (patternType && !counted.has(patternType)) {
            score += getClusterWeight(patternType, perspective);
            counted.add(patternType);
        }
    }
    
    return score;
}

// ─── Influence Map & Connection Detection ────────────────────────────────────────
function buildInfluenceMap(board, player) {
    const size = board.length;
    const influence = Array(size).fill(null).map(() => Array(size).fill(0));
    
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (board[r][c] === player) {
                for (let dr = -4; dr <= 4; dr++) {
                    for (let dc = -4; dc <= 4; dc++) {
                        const nr = r + dr, nc = c + dc;
                        if (0 <= nr && nr < size && 0 <= nc && nc < size && board[nr][nc] === 0) {
                            const dist = Math.max(Math.abs(dr), Math.abs(dc));
                            influence[nr][nc] += 5 - dist;
                        }
                    }
                }
            }
        }
    }
    return influence;
}

function classifyConnection(board, row, col, player) {
    // Temporarily place a stone at this empty cell so pattern detection is meaningful
    board[row][col] = player;

    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    let openThrees = 0;
    let fours = 0;

    for (const [dr, dc] of directions) {
        const line = getLine(row, col, dr, dc, player, board);
        if (line.includes('_OOOO_')) fours += 2;
        else if (line.includes('OOOO')) fours += 1;
        if (line.includes('_OOO_')) openThrees += 1;
    }

    // Restore the cell
    board[row][col] = 0;

    if (fours >= 2) return 'pincer_threat';
    if (fours >= 1 && openThrees >= 1) return 'bridge_threat';
    if (openThrees >= 2) return 'nearby_threes';
    if (openThrees >= 1) return 'supporting_threat';
    return null;
}

function evaluateClusterConnections(board, player, perspective) {
    const influence = buildInfluenceMap(board, player);
    let score = 0;
    const counted = new Set();
    const size = board.length;
    
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (influence[r][c] >= 4 && board[r][c] === 0) {
                const connType = classifyConnection(board, r, c, player);
                if (connType && !counted.has(connType)) {
                    score += getClusterConnectionWeight(connType, perspective) * (influence[r][c] / 5);
                    counted.add(connType);
                }
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

    // At leaf nodes, compute the accurate full board score.
    // fullEvaluateBoard uses line-based evaluation (no double-counting).
    const score = fullEvaluateBoard(board);
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
