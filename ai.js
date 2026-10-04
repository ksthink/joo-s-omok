// ─── AI Engine for Omok ────────────────────────────────────────────────────────
// Minimax with alpha-beta pruning, iterative deepening, Zobrist hashing,
// transposition table, killer moves, a tactical threat layer that restricts
// candidates at every node, cached leaf evaluation, and bidirectional learned
// pattern weights (attack/defense) for positional evaluation.

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

const getClusterWeight = function (patternId, perspective) {
    if (clusterWeights && clusterWeights[perspective] && clusterWeights[perspective][patternId] !== undefined) {
        return clusterWeights[perspective][patternId];
    }
    return CLUSTER_PATTERNS[patternId] || 1000;
};

const getClusterConnectionWeight = function (connType, perspective) {
    if (clusterConnectionWeights && clusterConnectionWeights[perspective] && clusterConnectionWeights[perspective][connType] !== undefined) {
        return clusterConnectionWeights[perspective][connType];
    }
    return CLUSTER_CONNECTION_PATTERNS[connType] || 1000;
};

// perspective: 'attack' for AI stones, 'defense' for player stones
const getPatternWeight = function (pattern, perspective) {
    if (patternWeights && perspective && patternWeights[perspective] && patternWeights[perspective][pattern] !== undefined) {
        return patternWeights[perspective][pattern];
    }
    return BASE_WEIGHTS[pattern] || 0;
};

// ─── Game Phase Detection ──────────────────────────────────────────────────────
let currentMoveCount = 0;

const getGamePhase = function () {
    if (currentMoveCount <= 10) return 'opening';
    if (currentMoveCount <= 30) return 'midgame';
    return 'endgame';
};

// ─── Exclusive Pattern Matching (no double-counting) ───────────────────────────
// Matches patterns greedily by priority (longest/highest-weight first).
// Once a region of the line is matched, it cannot be matched again.
const evaluateLine = function (line, perspective) {
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
};

// ─── Zobrist Hashing (dual 32-bit for reduced collisions) ──────────────────────
const ZOBRIST_TABLE = Array.from({length: 15}, () =>
    Array.from({length: 15}, () => [
        [Math.floor(Math.random() * 0x100000000), Math.floor(Math.random() * 0x100000000)],
        [Math.floor(Math.random() * 0x100000000), Math.floor(Math.random() * 0x100000000)],
    ])
);

let zobristHashHi = 0;
let zobristHashLo = 0;

// Per-player hashes (index 1 and 2) of the same table, used by evaluation caches
const zobristPlayerHi = [0, 0, 0];
const zobristPlayerLo = [0, 0, 0];

const updateZobristHash = function (row, col, player) {
    const z = ZOBRIST_TABLE[row][col][player - 1];
    zobristHashHi ^= z[0];
    zobristHashLo ^= z[1];
    zobristPlayerHi[player] ^= z[0];
    zobristPlayerLo[player] ^= z[1];
};

const resetSearchHashes = function (board) {
    zobristHashHi = 0; zobristHashLo = 0;
    zobristPlayerHi[1] = zobristPlayerHi[2] = 0;
    zobristPlayerLo[1] = zobristPlayerLo[2] = 0;
    for (let i = 0; i < board.length; i++) {
        for (let j = 0; j < board.length; j++) {
            if (board[i][j] !== 0) updateZobristHash(i, j, board[i][j]);
        }
    }
};

const computeFullHash = function (board) {
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
};

const getHashKey = function () {
    // Combine into a single string key for Map lookup
    return zobristHashHi + '|' + zobristHashLo;
};

// ─── Transposition Table (depth-based replacement) ─────────────────────────────
const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX_SIZE = 500000;
const transpositionTable = new Map();

const storeTT = function (depth, score, move, flag) {
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
};

const lookupTT = function () {
    return transpositionTable.get(getHashKey()) || null;
};

// ─── Killer Moves ──────────────────────────────────────────────────────────────
const MAX_KILLER_DEPTH = 12;
const killerMoves = Array.from({length: MAX_KILLER_DEPTH + 1}, () => [null, null]);

const updateKillerMove = function (depth, move) {
    if (depth <= MAX_KILLER_DEPTH && !movesEqual(killerMoves[depth][0], move)) {
        killerMoves[depth][1] = killerMoves[depth][0];
        killerMoves[depth][0] = { row: move.row, col: move.col };
    }
};

const movesEqual = function (a, b) {
    if (!a || !b) return false;
    return a.row === b.row && a.col === b.col;
};

// ─── Move Application & Evaluation Caching ─────────────────────────────────────
// The evaluation is not incremental: the board is scored from scratch at leaf
// nodes only. What is kept up to date per move is cheap state (Zobrist hashes,
// the padded flat board), and the expensive parts are memoised instead:
// line scores by line contents, cluster shapes by per-player hash and whole
// leaf results by position hash.

const applyMoveIncremental = function (board, row, col, player) {
    board[row][col] = player;
    setFlatCell(board, row, col, player);
    updateZobristHash(row, col, player);
};

const undoMoveIncremental = function (board, row, col, player) {
    board[row][col] = 0;
    setFlatCell(board, row, col, 0);
    updateZobristHash(row, col, player);
};

// Build a full-length line string along direction (dr,dc) starting at (r0,c0).
// Uses board boundaries as line ends (no fixed window).
const getFullLine = function (r0, c0, dr, dc, player, board) {
    const size = board.length;
    let line = '';
    // Walk from start to end of the board in this direction
    for (let r = r0, c = c0; r >= 0 && r < size && c >= 0 && c < size; r += dr, c += dc) {
        if (board[r][c] === player) line += 'O';
        else if (board[r][c] === 0) line += '_';
        else line += 'X';
    }
    return line;
};

// Gapped fours (OO_OO, O_OOO, OOO_O): one stone completes five through the gap.
// evaluateLine has no key for them, so each gap is scored like a closed four
// using the learned 'OOOO_' weight. Contiguous fours are left to evaluateLine,
// so no shape is counted twice.
const countGappedFours = function (line) {
    let n = 0;
    for (let i = 1; i < line.length - 1; i++) {
        if (line[i] !== '_' || line[i - 1] !== 'O' || line[i + 1] !== 'O') continue;
        let run = 0;
        for (let k = i - 1; k >= 0 && line[k] === 'O'; k--) run++;
        for (let k = i + 1; k < line.length && line[k] === 'O'; k++) run++;
        if (run >= 4) n++;
    }
    return n;
};

const scoreLine = function (line, perspective) {
    let score = evaluateLine(line, perspective);
    if (line.indexOf('O_O') !== -1) {
        const gapped = countGappedFours(line);
        if (gapped) score += gapped * getPatternWeight('OOOO_', perspective);
    }
    return score;
};

// Line scores are memoised by line contents (base-3 code + length + perspective).
// Most lines are unchanged between leaves, so the pattern scan runs rarely.
// The cache is cleared at the start of every getAIMove() so newly loaded
// learned weights are always used.
const lineScoreCache = new Map();
const LINE_CACHE_MAX = 200000;

const lineScoreCached = function (r0, c0, dr, dc, player, board, perspective) {
    const size = board.length;
    let code = 0, len = 0;
    for (let r = r0, c = c0; r >= 0 && r < size && c >= 0 && c < size; r += dr, c += dc) {
        const v = board[r][c];
        code = code * 3 + (v === player ? 1 : (v === 0 ? 0 : 2));
        len++;
    }
    const key = ((code * 16 + len) * 2) + (perspective === 'attack' ? 1 : 0);
    let score = lineScoreCache.get(key);
    if (score === undefined) {
        score = scoreLine(getFullLine(r0, c0, dr, dc, player, board), perspective);
        if (lineScoreCache.size >= LINE_CACHE_MAX) lineScoreCache.clear();
        lineScoreCache.set(key, score);
    }
    return score;
};

// Score all unique lines on the board once per direction.
// Horizontal: 15 rows, Vertical: 15 cols, Diag \: top-row + left-col, Diag /: bottom-row + left-col.
const evaluateAllLines = function (board, player, perspective) {
    const size = board.length;
    let score = 0;

    // Horizontal lines (dr=0, dc=1) – one per row
    for (let r = 0; r < size; r++) {
        score += lineScoreCached(r, 0, 0, 1, player, board, perspective);
    }
    // Vertical lines (dr=1, dc=0) – one per col
    for (let c = 0; c < size; c++) {
        score += lineScoreCached(0, c, 1, 0, player, board, perspective);
    }
    // Diagonal \ (dr=1, dc=1) – top row + left col (excluding corner double-count)
    for (let c = 0; c < size; c++) {
        score += lineScoreCached(0, c, 1, 1, player, board, perspective);
    }
    for (let r = 1; r < size; r++) {
        score += lineScoreCached(r, 0, 1, 1, player, board, perspective);
    }
    // Diagonal / (dr=-1, dc=1) – bottom row + left col
    for (let c = 0; c < size; c++) {
        score += lineScoreCached(size - 1, c, -1, 1, player, board, perspective);
    }
    for (let r = 0; r < size - 1; r++) {
        score += lineScoreCached(r, 0, -1, 1, player, board, perspective);
    }

    return score;
};

// ─── Full Board Evaluation (used for initialization) ───────────────────────────
// `connections` (optional): [_, defense score, attack score] already computed by
// the leaf scan, so the candidate cells are not classified twice.
// Internal helpers are script-scoped consts rather than function declarations:
// behaviour in the browser is the same, but in a Node vm context (used by the
// tests and the match harness) calls to global function declarations go
// through the sandbox's property interceptor and are several times slower.
// The public API (getAIMove, loadPatternWeights, fullEvaluateBoard,
// classifyMove, linePoints, countThreats, ...) stays global.
const evaluatePositional = function (board, connections) {
    let score = 0;

    // Line-based scan: each line evaluated exactly once per direction, no double-counting
    score += evaluateAllLines(board, 2, 'attack');
    score -= evaluateAllLines(board, 1, 'defense');

    score += evaluateClusterPatterns(board, 2, 'attack');
    score -= evaluateClusterPatterns(board, 1, 'defense');
    if (connections) {
        score += connections[2] - connections[1];
    } else {
        score += evaluateClusterConnections(board, 2, 'attack');
        score -= evaluateClusterConnections(board, 1, 'defense');
    }

    return score;
};

function fullEvaluateBoard(board) {
    return evaluatePositional(board);
}

// ─── Cluster Pattern Detection ──────────────────────────────────────────────────
const findClusters = function (board, player) {
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
};

const getClusterBounds = function (cluster) {
    const rows = cluster.map(p => p[0]);
    const cols = cluster.map(p => p[1]);
    return [Math.min(...rows), Math.max(...rows), Math.min(...cols), Math.max(...cols)];
};

const identifyClusterPattern = function (cluster, board) {
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
};

// Cluster shapes depend only on one player's stones, so they are cached by that
// player's Zobrist hash (cleared every getAIMove).
const clusterScoreCache = new Map();

const evaluateClusterPatterns = function (board, player, perspective) {
    const key = player + '|' + perspective + '|' + zobristPlayerHi[player] + '|' + zobristPlayerLo[player];
    let score = clusterScoreCache.get(key);
    if (score === undefined) {
        score = evaluateClusterPatternsUncached(board, player, perspective);
        if (clusterScoreCache.size >= LINE_CACHE_MAX) clusterScoreCache.clear();
        clusterScoreCache.set(key, score);
    }
    return score;
};

const evaluateClusterPatternsUncached = function (board, player, perspective) {
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
};

// ─── Influence Map & Connection Detection ────────────────────────────────────────
// Influence of `player` on an empty cell: sum of (5 - chebyshev distance) over
// own stones within 4 cells. A connection is scored at the first cell (row-major)
// with influence >= 4 for each connection type.
//
// Any cell where a stone makes a three or four has an own stone within 2 cells,
// so only the move candidates (radius 2 around stones) need to be classified,
// and influence is computed only for cells that have a connection type.
const CONNECTION_TYPES = ['pincer_threat', 'bridge_threat', 'nearby_threes', 'supporting_threat'];

const influenceAt = function (board, r, c, player) {
    const size = board.length;
    let inf = 0;
    const r0 = Math.max(0, r - 4), r1 = Math.min(size - 1, r + 4);
    const c0 = Math.max(0, c - 4), c1 = Math.min(size - 1, c + 4);
    for (let nr = r0; nr <= r1; nr++) {
        const row = board[nr];
        const adr = nr > r ? nr - r : r - nr;
        for (let nc = c0; nc <= c1; nc++) {
            if (row[nc] !== player) continue;
            const adc = nc > c ? nc - c : c - nc;
            inf += 5 - (adr > adc ? adr : adc);
        }
    }
    return inf;
};

// Index into CONNECTION_TYPES for a threatBits() summary, or -1
const connectionIndexFromBits = function (bits) {
    if (!bits) return -1;
    const fours = (bits & 7) * 2 + ((bits >> 3) & 7) + ((bits & 512) ? 1 : 0);
    const openThrees = (bits >> 6) & 7;
    if (fours >= 2) return 0;
    if (fours >= 1 && openThrees >= 1) return 1;
    if (openThrees >= 2) return 2;
    if (openThrees >= 1) return 3;
    return -1;
};

// Connection type a `player` stone at empty (row,col) would create.
// Shapes come from the tactical layer (gapped fours/threes included).
const classifyConnection = function (board, row, col, player) {
    const idx = connectionIndexFromBits(threatBits(board, row, col, player));
    return idx < 0 ? null : CONNECTION_TYPES[idx];
};

const evaluateClusterConnections = function (board, player, perspective) {
    const size = board.length;
    const keys = collectCandidates(board).sort((x, y) => x - y);
    let score = 0;
    let counted = 0; // bit per connection type, each type scored once
    for (const key of keys) {
        const r = (key / size) | 0, c = key % size;
        const idx = connectionIndexFromBits(threatBits(board, r, c, player));
        if (idx < 0 || (counted & (1 << idx))) continue;
        const inf = influenceAt(board, r, c, player);
        if (inf < 4) continue;
        score += getClusterConnectionWeight(CONNECTION_TYPES[idx], perspective) * (inf / 5);
        counted |= 1 << idx;
        if (counted === 15) break;
    }
    return score;
};

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

// ─── Tactical Layer (independent of learned weights) ───────────────────────────
// Threat detection used for move generation, forced-move handling and the
// side-to-move aware leaf check. It never reads patternWeights: learned weights
// only affect positional evaluation, while these definitions are fixed rules.
//
// The threat grades and the idea of treating one-gap shapes (OO_OO, O_OOO,
// _O_OO_ ...) as real fours/threes are adapted from Gomoku-MiniMax
// (https://github.com/yups1199/Gomoku-MiniMax, model.py get_info_from_line /
// moves_in_priority, heuristic_weights.py PRIORITY), MIT License,
// Copyright (c) 2026 JeongYupKim. The implementation below is a rewrite that
// works on a 9-cell window around the move instead of line segments.
const DIRS4 = [[0, 1], [1, 0], [1, 1], [1, -1]];

// Per-direction shape of a move
const D_NONE = 0, D_THREE = 1, D_FOUR = 2, D_OPEN_FOUR = 3, D_FIVE = 4;

// Move grades (higher = stronger), mirrors Gomoku-MiniMax PRIORITY ordering
const G_NONE = 0;
const G_THREE = 1;        // one open three
const G_FOUR = 2;         // one four (closed or one-gap)
const G_DOUBLE_THREE = 3; // 쌍삼
const G_FOUR_THREE = 4;   // 사삼
const G_WINNING = 5;      // open four or 쌍사
const G_FIVE = 6;

// Window cells: 0 = empty, 1 = own stone, 2 = opponent stone or off-board.
// Index 4 is the move itself and is always treated as own.
const _win = new Int8Array(9);

// Padded flat copy of the board being searched (4-cell wall of 3s around the
// 15x15 board). It is kept in sync by applyMoveIncremental/undoMoveIncremental
// so window reads need no bounds checks. Any other board takes the slow path.
const FLAT_PAD = 4;
const FLAT_W = 15 + 2 * FLAT_PAD;
const flatBoard = new Int8Array(FLAT_W * FLAT_W);
let flatOwner = null;

const setSearchBoard = function (board) {
    flatBoard.fill(3);
    for (let r = 0; r < 15; r++) {
        for (let c = 0; c < 15; c++) flatBoard[(r + FLAT_PAD) * FLAT_W + c + FLAT_PAD] = board[r][c];
    }
    flatOwner = board;
};

const setFlatCell = function (board, r, c, v) {
    if (board === flatOwner) flatBoard[(r + FLAT_PAD) * FLAT_W + c + FLAT_PAD] = v;
};

const readWindow = function (board, r, c, dr, dc, player, out) {
    if (board === flatOwner) {
        const base = (r + FLAT_PAD) * FLAT_W + c + FLAT_PAD;
        const step = dr * FLAT_W + dc;
        let own = 1;
        for (let k = -4; k <= 4; k++) {
            if (k === 0) { out[4] = 1; continue; }
            const v = flatBoard[base + k * step];
            if (v === player) { out[k + 4] = 1; own++; }
            else out[k + 4] = v === 0 ? 0 : 2;
        }
        return own;
    }
    const size = board.length;
    for (let k = -4; k <= 4; k++) {
        if (k === 0) { out[4] = 1; continue; }
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) out[k + 4] = 2;
        else {
            const v = board[rr][cc];
            out[k + 4] = v === player ? 1 : (v === 0 ? 0 : 2);
        }
    }
    let own = 0;
    for (let k = 0; k < 9; k++) if (out[k] === 1) own++;
    return own;
};

// Bitmask of empty window cells that complete five-or-more through the centre.
// Overlines count as wins (free gomoku). A ±4 window is enough: any winning run
// that touches the window edge already spans five cells.
const windowWinMask = function (a) {
    let mask = 0;
    for (let i = 0; i < 9; i++) {
        if (i === 4 || a[i] !== 0) continue;
        const lo = i < 4 ? i : 4, hi = i < 4 ? 4 : i;
        let ok = true;
        for (let k = lo + 1; k < hi; k++) if (a[k] !== 1) { ok = false; break; }
        if (!ok) continue;
        let L = lo, R = hi;
        while (L > 0 && a[L - 1] === 1) L--;
        while (R < 8 && a[R + 1] === 1) R++;
        if (R - L + 1 >= 5) mask |= 1 << i;
    }
    return mask;
};

const popcount9 = function (m) {
    let n = 0;
    while (m) { m &= m - 1; n++; }
    return n;
};

const classifyWindow = function (a) {
    let L = 4, R = 4;
    while (L > 0 && a[L - 1] === 1) L--;
    while (R < 8 && a[R + 1] === 1) R++;
    if (R - L + 1 >= 5) return D_FIVE;

    // Free segment around the centre (bounded by opponent / edge)
    let s = 4, e = 4;
    while (s > 0 && a[s - 1] !== 2) s--;
    while (e < 8 && a[e + 1] !== 2) e++;
    if (e - s + 1 < 5) return D_NONE;
    let own = 0;
    for (let k = s; k <= e; k++) if (a[k] === 1) own++;
    if (own < 3) return D_NONE;

    const n = popcount9(windowWinMask(a));
    if (n >= 2) return D_OPEN_FOUR;
    if (n === 1) return D_FOUR;

    // Open three: one more stone makes an open four (two winning points)
    for (let j = s; j <= e; j++) {
        if (a[j] !== 0) continue;
        a[j] = 1;
        const m2 = windowWinMask(a);
        a[j] = 0;
        if (popcount9(m2) >= 2) return D_THREE;
    }
    return D_NONE;
};

// Packed threat summary: bit 9 five, bits 0-2 open fours, 3-5 fours, 6-8 threes
const threatBits = function (board, r, c, player) {
    let bits = 0;
    for (let d = 0; d < 4; d++) {
        // fewer than 3 own stones in the window: nothing to classify
        if (readWindow(board, r, c, DIRS4[d][0], DIRS4[d][1], player, _win) < 3) continue;
        switch (classifyWindow(_win)) {
            case D_FIVE: bits |= 512; break;
            case D_OPEN_FOUR: bits += 1; break;
            case D_FOUR: bits += 8; break;
            case D_THREE: bits += 64; break;
        }
    }
    return bits;
};

// Same as threatBits, and also stores the move's shape potential in
// lastPotential: for every five-cell window through the move holding no
// opponent stone, POTENTIAL[own stones] is added. Used to order quiet moves.
const POTENTIAL = [0, 1, 6, 30, 150, 0];
let lastPotential = 0;

const threatBitsWithPotential = function (board, r, c, player) {
    let bits = 0;
    let potential = 0;
    for (let d = 0; d < 4; d++) {
        readWindow(board, r, c, DIRS4[d][0], DIRS4[d][1], player, _win);
        for (let s = 0; s <= 4; s++) {
            let cnt = 0;
            for (let k = s; k < s + 5; k++) {
                const v = _win[k];
                if (v === 2) { cnt = -1; break; }
                cnt += v;
            }
            if (cnt > 0) potential += POTENTIAL[cnt];
        }
        switch (classifyWindow(_win)) {
            case D_FIVE: bits |= 512; break;
            case D_OPEN_FOUR: bits += 1; break;
            case D_FOUR: bits += 8; break;
            case D_THREE: bits += 64; break;
        }
    }
    lastPotential = potential;
    return bits;
};

const gradeOfBits = function (bits) {
    if (bits & 512) return G_FIVE;
    const openFour = bits & 7, four = (bits >> 3) & 7, three = (bits >> 6) & 7;
    if (openFour > 0 || four >= 2) return G_WINNING;
    if (four >= 1 && three >= 1) return G_FOUR_THREE;
    if (three >= 2) return G_DOUBLE_THREE;
    if (four >= 1) return G_FOUR;
    if (three >= 1) return G_THREE;
    return G_NONE;
};

// Empty cells on the line through (r,c) in direction (dr,dc) where one more
// `player` stone completes five or more together with (r,c).
// (r,c) itself is assumed to hold a `player` stone.
function linePoints(board, r, c, dr, dc, player) {
    readWindow(board, r, c, dr, dc, player, _win);
    const mask = windowWinMask(_win);
    const pts = [];
    for (let i = 0; i < 9; i++) {
        if (mask & (1 << i)) pts.push({ row: r + dr * (i - 4), col: c + dc * (i - 4) });
    }
    return pts;
}

// Assume a `player` stone at (r,c) and describe the threats it makes.
function classifyMove(board, r, c, player) {
    const bits = threatBits(board, r, c, player);
    return {
        five: (bits & 512) !== 0,
        openFour: bits & 7,
        fourCount: (bits >> 3) & 7,
        openThreeCount: (bits >> 6) & 7,
        grade: gradeOfBits(bits)
    };
}

// ─── Search Scores & Side-to-move Aware Leaf ───────────────────────────────────
// A won game scores WIN + remaining depth (faster wins score higher), a lost one
// -(WIN + depth). Scores are always from the AI's (player 2) point of view.
// Depth-adjusted win scores and the single-reply extension below follow
// Gomoku-MiniMax minimax() (https://github.com/yups1199/Gomoku-MiniMax,
// MIT License, Copyright (c) 2026 JeongYupKim).
const WIN = 1e9;
const CERTAIN_WIN = WIN - 100;   // |score| >= this: the result is proven
const NEAR_WIN = 1e7;            // winning attack available to the side to move

// Would a `player` stone at empty (r,c) make five or more?
const makesFive = function (board, r, c, player) {
    const size = board.length;
    for (let d = 0; d < 4; d++) {
        const dr = DIRS4[d][0], dc = DIRS4[d][1];
        let n = 1;
        for (let k = 1; k < 5; k++) {
            const rr = r + dr * k, cc = c + dc * k;
            if (rr < 0 || rr >= size || cc < 0 || cc >= size || board[rr][cc] !== player) break;
            n++;
        }
        for (let k = 1; k < 5; k++) {
            const rr = r - dr * k, cc = c - dc * k;
            if (rr < 0 || rr >= size || cc < 0 || cc >= size || board[rr][cc] !== player) break;
            n++;
        }
        if (n >= 5) return true;
    }
    return false;
};

// One pass over the candidate cells at a leaf. For both players it classifies
// the move at every cell once and derives
//   - the tactical verdict from `side`'s point of view:
//       +2  side has a five point (wins next move)
//       -2  opponent has two or more five points that side cannot all block
//       +1  side can make an open four / 쌍사 / 사삼 and the opponent has no four
//        0  no verdict, use the positional evaluation
//   - the cluster connection scores (same result as evaluateClusterConnections)
const _leafConn = [0, 0, 0];

const leafScan = function (board, side) {
    const opp = 3 - side;
    const size = board.length;
    const keys = collectCandidates(board).sort((x, y) => x - y);
    let oppFives = 0;
    let strong = false;
    let counted1 = 0, counted2 = 0;
    _leafConn[1] = 0; _leafConn[2] = 0;
    for (const key of keys) {
        const r = (key / size) | 0, c = key % size;
        for (let p = 1; p <= 2; p++) {
            const bits = threatBits(board, r, c, p);
            if (!bits) continue;
            if (p === side) {
                if (bits & 512) return 2;
                if (!strong && gradeOfBits(bits) >= G_FOUR_THREE) strong = true;
            } else if (bits & 512) {
                oppFives++;
            }
            const idx = connectionIndexFromBits(bits);
            if (idx < 0) continue;
            const bit = 1 << idx;
            if ((p === 1 ? counted1 : counted2) & bit) continue;
            const inf = influenceAt(board, r, c, p);
            if (inf < 4) continue;
            _leafConn[p] += getClusterConnectionWeight(CONNECTION_TYPES[idx], p === 2 ? 'attack' : 'defense') * (inf / 5);
            if (p === 1) counted1 |= bit; else counted2 |= bit;
        }
    }
    if (oppFives >= 2) return -2;
    if (strong && oppFives === 0) return 1;
    return 0;
};

// Tactical verdict only (see leafScan)
const leafTactics = function (board, side) {
    return leafScan(board, side);
};

// Leaf results cached by position + side to move (cleared every getAIMove)
const leafCache = new Map();

// Counters of the last getAIMove() search, for benchmarks
const searchStats = { nodes: 0, leafEvals: 0, uncachedEvals: 0, depth: 0, ms: 0 };

// Score of the deepest completed root search (AI's point of view)
let lastRootScore = 0;
// Whether the last getValidMovesSmart() call found a quiet position (no forcing threats)
let lastMovesQuiet = false;

function getSearchStats() {
    return Object.assign({}, searchStats);
}

const evaluateLeaf = function (board, side) {
    searchStats.leafEvals++;
    const key = getHashKey() + '|' + side;
    let score = leafCache.get(key);
    if (score === undefined) {
        searchStats.uncachedEvals++;
        score = evaluateLeafUncached(board, side);
        if (leafCache.size >= TT_MAX_SIZE) leafCache.clear();
        leafCache.set(key, score);
    }
    return score;
};

const evaluateLeafUncached = function (board, side) {
    const sign = side === 2 ? 1 : -1;
    const verdict = leafScan(board, side);
    if (verdict === 2) return sign * (WIN - 1);
    if (verdict === -2) return -sign * (WIN - 2);
    const positional = evaluatePositional(board, _leafConn);
    if (verdict === 1) return sign * NEAR_WIN + positional;
    return positional;
};

// ─── Entry Point ───────────────────────────────────────────────────────────────
// Forced replies (own five, blocking the opponent's five) come out of
// getValidMovesSmart as a single candidate and are returned without searching.
const MAX_EXTENSIONS = 8; // single-reply extensions allowed on one search path

function getAIMove(board, timeLimit) {
    if (prepareSearch(board) === 0) {
        return { row: 7, col: 7 };
    }

    try {
        const rootMoves = getValidMovesSmart(board, null, 1, 2);
        if (rootMoves.length === 0) return null;
        if (rootMoves.length === 1) return rootMoves[0];

        return getAIMoveIterativeDeepening(board, timeLimit || 1000);
    } finally {
        // The flat mirror is only valid while this search owns the board
        flatOwner = null;
    }
}

// Count stones, reset per-search state and point the flat mirror at `board`.
// Returns the stone count; the caller must clear flatOwner when done.
const prepareSearch = function (board) {
    currentMoveCount = 0;
    for (let i = 0; i < 15; i++) {
        for (let j = 0; j < 15; j++) {
            if (board[i][j] !== 0) currentMoveCount++;
        }
    }

    searchStats.nodes = searchStats.leafEvals = searchStats.uncachedEvals = searchStats.depth = 0;
    searchStats.ms = 0;
    lastRootScore = 0;

    if (currentMoveCount === 0) return 0;

    transpositionTable.clear();
    for (let i = 0; i <= MAX_KILLER_DEPTH; i++) {
        killerMoves[i][0] = null;
        killerMoves[i][1] = null;
    }
    resetSearchHashes(board);
    setSearchBoard(board);
    lineScoreCache.clear();
    clusterScoreCache.clear();
    leafCache.clear();
    return currentMoveCount;
};

// ─── Candidate Analysis (for the Jev intuition layer) ──────────────────────────
// Runs the normal search, then re-scores the top root candidates with a
// full-window search of one common depth so their scores are comparable.
// `forced: true` means tactics decide the move (five, blocking a four or an open
// three, a proven win/loss): the caller must play `move` and skip any intuition.
// Candidate scores are from the AI's point of view; `notes` describe the shape
// each move makes for the AI (me) and denies the human (opp).
const GRADE_NAMES = ['none', 'three', 'four', 'double-three', 'four-three', 'winning', 'five'];

function getAIMoveAnalysis(board, timeLimit, opts) {
    opts = opts || {};
    const maxCandidates = opts.candidates || 8;
    const maxScoreDepth = opts.scoreDepth || 4;
    timeLimit = timeLimit || 1000;
    const scoreBudget = opts.scoreTimeMs || Math.max(150, timeLimit * 0.5);
    const forced = move => ({ move, forced: true, candidates: [], depth: searchStats.depth });

    if (prepareSearch(board) === 0) return forced({ row: 7, col: 7 });

    try {
        const rootMoves = getValidMovesSmart(board, null, 1, 2);
        const quiet = lastMovesQuiet;
        if (rootMoves.length === 0) return forced(null);
        if (rootMoves.length === 1) return forced(rootMoves[0]);
        if (!quiet) return forced(getAIMoveIterativeDeepening(board, timeLimit));

        const best = getAIMoveIterativeDeepening(board, timeLimit);
        if (!best || Math.abs(lastRootScore) >= CERTAIN_WIN) return forced(best);

        const list = [best].concat(rootMoves.filter(m => !movesEqual(m, best))).slice(0, maxCandidates);
        const depth = Math.max(1, Math.min(searchStats.depth - 1, maxScoreDepth));
        const startTime = Date.now();
        const candidates = [];
        for (const m of list) {
            applyMoveIncremental(board, m.row, m.col, 2);
            const r = minimax(board, depth - 1, -Infinity, Infinity, false, startTime, scoreBudget, 0, m);
            undoMoveIncremental(board, m.row, m.col, 2);
            if (r.timeout) break;
            const me = gradeOfBits(threatBits(board, m.row, m.col, 2));
            const opp = gradeOfBits(threatBits(board, m.row, m.col, 1));
            candidates.push({ row: m.row, col: m.col, score: r.score, me: GRADE_NAMES[me], opp: GRADE_NAMES[opp] });
        }
        // The best move must be part of a comparable set, otherwise skip intuition
        if (candidates.length < 2) return forced(best);
        return { move: best, forced: false, candidates, depth };
    } finally {
        flatOwner = null;
    }
}

const getAIMoveIterativeDeepening = function (board, timeLimitMs) {
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
        lastRootScore = result.score;
        searchStats.depth = depth;
        if (Math.abs(result.score) >= CERTAIN_WIN) break;
    }
    searchStats.ms = Date.now() - startTime;
    return bestMove;
};

const minimaxRoot = function (board, depth, startTime, timeLimitMs, previousBestMove) {
    const moves = getValidMovesSmart(board, previousBestMove, depth, 2);
    if (moves.length === 0) return { score: 0, move: null, timeout: false };

    let bestMove = moves[0];
    let bestScore = -Infinity;
    const childDepth = moves.length === 1 ? depth : depth - 1;
    const childExt = moves.length === 1 ? 1 : 0;

    for (const move of moves) {
        if (Date.now() - startTime > timeLimitMs) {
            return { score: bestScore, move: bestMove, timeout: true };
        }

        applyMoveIncremental(board, move.row, move.col, 2);

        const result = minimax(board, childDepth, bestScore, Infinity, false, startTime, timeLimitMs, childExt, move);

        undoMoveIncremental(board, move.row, move.col, 2);

        if (result.timeout) {
            return { score: bestScore, move: bestMove, timeout: true };
        }

        if (result.score > bestScore) {
            bestScore = result.score;
            bestMove = move;
        }
    }

    return { score: bestScore, move: bestMove, timeout: false };
};

const minimax = function (board, depth, alpha, beta, isMaximizing, startTime, timeLimitMs, ext, lastMove) {
    searchStats.nodes++;
    if (Date.now() - startTime > timeLimitMs) {
        return { score: 0, move: null, timeout: true };
    }
    ext = ext || 0;

    // Terminal check: did the move that led here make five?
    if (lastMove) {
        const lastPlayer = isMaximizing ? 1 : 2;
        if (checkWinSimple(lastMove.row, lastMove.col, lastPlayer, board)) {
            const score = lastPlayer === 2 ? WIN + depth : -(WIN + depth);
            return { score, move: null, timeout: false };
        }
    }

    // Transposition table lookup
    const ttEntry = lookupTT();
    if (ttEntry && ttEntry.depth >= depth) {
        if (ttEntry.flag === TT_EXACT) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
        if (ttEntry.flag === TT_LOWER) alpha = Math.max(alpha, ttEntry.score);
        if (ttEntry.flag === TT_UPPER) beta = Math.min(beta, ttEntry.score);
        if (alpha >= beta) return { score: ttEntry.score, move: ttEntry.move, timeout: false };
    }

    const player = isMaximizing ? 2 : 1;

    // Leaf: side-to-move aware evaluation (the only place the board is scored)
    if (depth <= 0) {
        return { score: evaluateLeaf(board, player), move: null, timeout: false };
    }

    const ttBestMove = ttEntry ? ttEntry.move : null;
    const moves = getValidMovesSmart(board, ttBestMove, depth, player);
    if (moves.length === 0) {
        return { score: 0, move: null, timeout: false };
    }

    // Single forced reply: search it without spending depth (bounded per path)
    let childDepth = depth - 1, childExt = ext;
    if (moves.length === 1 && ext < MAX_EXTENSIONS) {
        childDepth = depth;
        childExt = ext + 1;
    }

    let bestMove = moves[0];
    const originalAlpha = alpha;

    if (isMaximizing) {
        let maxScore = -Infinity;

        for (const move of moves) {
                applyMoveIncremental(board, move.row, move.col, 2);

            const result = minimax(board, childDepth, alpha, beta, false, startTime, timeLimitMs, childExt, move);

            undoMoveIncremental(board, move.row, move.col, 2);
    
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
                applyMoveIncremental(board, move.row, move.col, 1);

            const result = minimax(board, childDepth, alpha, beta, true, startTime, timeLimitMs, childExt, move);

            undoMoveIncremental(board, move.row, move.col, 1);
    
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
};

// ─── Move Generation: threat-restricted candidates ─────────────────────────────
// Every node (root and interior) uses the same rules, `player` being the side to
// move ("me") and 3 - player the opponent:
//   1. me can make five               -> only that move
//   2. opp has a five point           -> only a block (if several, the game is lost)
//   3. me can make an open four/쌍사   -> only those
//      me can make 사삼               -> those + up to RESERVE_MOVES best others
//   4. opp threatens an open four/쌍사/사삼/쌍삼 next move
//                                     -> blocks + my fours (+ my threes if opp's
//                                        threat is only a 쌍삼) + RESERVE_MOVES
//   5. otherwise                      -> best `width` moves by ordering score
// Thresholds and reserve size follow Gomoku-MiniMax moves_in_priority /
// determine_threshold (https://github.com/yups1199/Gomoku-MiniMax, MIT License,
// Copyright (c) 2026 JeongYupKim).
const AI_THREAT_WEIGHT = 1.1;
const RESERVE_MOVES = 5;
const MAX_FORCED_MOVES = 20;
const _candMark = new Uint8Array(225);

const collectCandidates = function (board) {
    const size = board.length;
    const out = [];
    _candMark.fill(0);
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] === 0) continue;
            const i0 = Math.max(0, i - 2), i1 = Math.min(size - 1, i + 2);
            const j0 = Math.max(0, j - 2), j1 = Math.min(size - 1, j + 2);
            for (let ni = i0; ni <= i1; ni++) {
                for (let nj = j0; nj <= j1; nj++) {
                    const key = ni * size + nj;
                    if (board[ni][nj] === 0 && !_candMark[key]) {
                        _candMark[key] = 1;
                        out.push(key);
                    }
                }
            }
        }
    }
    return out;
};

const getValidMovesSmart = function (board, previousBestMove, depth, player, width) {
    player = player || 2;
    width = width || 12;
    const opp = 3 - player;
    const size = board.length;
    lastMovesQuiet = false;
    const keys = collectCandidates(board);
    if (keys.length === 0) return [];

    const scored = [];
    let myBest = G_NONE, oppBest = G_NONE;
    for (const key of keys) {
        const row = (key / size) | 0, col = key % size;
        const myBits = threatBitsWithPotential(board, row, col, player);
        const myPot = lastPotential;
        const oppBits = threatBitsWithPotential(board, row, col, opp);
        const oppPot = lastPotential;
        const myGrade = gradeOfBits(myBits), oppGrade = gradeOfBits(oppBits);
        if (myGrade === G_FIVE) return [{ row, col }];
        if (myGrade > myBest) myBest = myGrade;
        if (oppGrade > oppBest) oppBest = oppGrade;

        let score = 0;
        if (previousBestMove && previousBestMove.row === row && previousBestMove.col === col) score += 1000000;
        if (depth !== undefined && depth <= MAX_KILLER_DEPTH) {
            const km = killerMoves[depth];
            if (km[0] && km[0].row === row && km[0].col === col) score += 900000;
            else if (km[1] && km[1].row === row && km[1].col === col) score += 800000;
        }
        score += threatScoreFromBits(myBits, player) * AI_THREAT_WEIGHT;
        score += threatScoreFromBits(oppBits, opp);
        score += myPot + oppPot * 0.8;
        scored.push({ row, col, score, myGrade, oppGrade });
    }

    scored.sort((a, b) => b.score - a.score);
    const strip = list => list.map(m => ({ row: m.row, col: m.col }));
    const withReserve = (selected, limit) => {
        let reserve = RESERVE_MOVES;
        for (const m of scored) {
            if (selected.length >= limit || reserve <= 0) break;
            if (!selected.includes(m)) { selected.push(m); reserve--; }
        }
        return strip(selected);
    };

    // 2. opponent already has a five point: block it
    if (oppBest === G_FIVE) {
        return strip([scored.find(m => m.oppGrade === G_FIVE)]);
    }
    // 3. my own winning / composite attack
    if (myBest === G_WINNING) {
        return strip(scored.filter(m => m.myGrade === G_WINNING));
    }
    if (myBest === G_FOUR_THREE) {
        return withReserve(scored.filter(m => m.myGrade >= G_FOUR_THREE), MAX_FORCED_MOVES);
    }
    // 4. opponent threatens a winning shape on the next move
    if (oppBest >= G_DOUBLE_THREE) {
        // Against a mere 쌍삼 threat my own threes still win the race; against an
        // open three (or worse) only fours keep the initiative.
        const counters = oppBest === G_DOUBLE_THREE
            ? m => m.myGrade >= G_THREE
            : m => m.myGrade === G_FOUR || m.myGrade >= G_FOUR_THREE;
        const selected = scored.filter(m => m.oppGrade >= G_DOUBLE_THREE || counters(m));
        return withReserve(selected.slice(0, MAX_FORCED_MOVES), MAX_FORCED_MOVES);
    }
    // 5. quiet position
    lastMovesQuiet = true;
    return strip(scored.slice(0, width));
};

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
// Threat shapes come from the tactical layer (gapped fours/threes included);
// learned weights only set the ordering scale, which is unchanged.
function countThreats(row, col, player, board) {
    return threatScoreFromBits(threatBits(board, row, col, player), player);
}

const threatScoreFromBits = function (bits, player) {
    const perspective = player === 2 ? 'attack' : 'defense';
    if (bits & 512) return getPatternWeight('OOOOO', perspective);
    const openFour = bits & 7, blockedFour = (bits >> 3) & 7, openThree = (bits >> 6) & 7;
    if (openFour >= 1 || blockedFour >= 2) return getPatternWeight('_OOOO_', perspective);
    if (blockedFour >= 1 && openThree >= 1) {
        return getPatternWeight('OOOO_', perspective) + getPatternWeight('_OOO_', perspective); // 사삼
    }
    if (openThree >= 2) return getPatternWeight('_OOO_', perspective) * 2; // 쌍삼
    return openThree * (getPatternWeight('_OOO_', perspective) * 0.6) + blockedFour * (getPatternWeight('OOOO_', perspective) * 0.1);
};

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

const checkWinSimple = function (row, col, player, board) {
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
};

// Legacy compatibility: evaluateBoard for any external callers
function evaluateBoard(board) {
    return fullEvaluateBoard(board);
}
