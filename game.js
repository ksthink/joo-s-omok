// 앱 버전: 첫 화면에 표시됨. 배포할 때 함께 올린다.
const APP_VERSION = '3.2.1';

const BOARD_SIZE = 15;
const EMPTY = 0;
const PLAYER = 1;
const AI = 2;

let CELL_SIZE = 22;
let CANVAS_SIZE = 0;

let board = [];
let currentPlayer = PLAYER;
let gameOver = false;

let gameMode = 'practice';
let playerColor = 'black'; // the player's stones; black moves first
let playerName = '';
let currentLevel = 1;
let totalScore = 0;
let levelStartTime = 0;
let totalStones = 0;
let levelStones = 0;
let timerInterval = null;
let elapsedSeconds = 0;
let introAnimationId = null;
let lastMove = null;
let moveHistory = [];
let gameSerial = 0; // bumped on every new board, so a late AI answer can be discarded
let engineWaited = false; // this board already waited once for the Rapfi download
let touchHandled = false; // prevent double-fire on mobile

// How long the AI's move waits for the Rapfi download in challenge mode before the
// built-in engine plays instead
const CHALLENGE_ENGINE_WAIT_MS = 20000;

// timeLimit: the built-in engine's thinking time, used only when Rapfi is unavailable
// (Rapfi's strength per level is RAPFI_LEVELS in rapfi.js)
const LEVEL_CONFIG = {
    1:  { timeLimit: 200,  baseScore: 100  },
    2:  { timeLimit: 300,  baseScore: 150  },
    3:  { timeLimit: 400,  baseScore: 200  },
    4:  { timeLimit: 500,  baseScore: 300  },
    5:  { timeLimit: 700,  baseScore: 400  },
    6:  { timeLimit: 900,  baseScore: 500  },
    7:  { timeLimit: 1200, baseScore: 650  },
    8:  { timeLimit: 1500, baseScore: 850  },
    9:  { timeLimit: 1800, baseScore: 1100 },
    10: { timeLimit: 2200, baseScore: 1500 },
};

let canvas, ctx;
let stoneAudio = null;

// ─── Stone Colors ──────────────────────────────────────────────────────────────
// Board cells hold PLAYER / AI; the color of each side depends on the player's pick.
function isBlackStone(player) {
    return (player === PLAYER) === (playerColor === 'black');
}

function aiColor() {
    return playerColor === 'black' ? 'white' : 'black';
}

// A win rate for the AI as the white side's win rate (what the win bar shows)
function aiToWhite(p) {
    return aiColor() === 'white' ? p : 1 - p;
}

function loadPlayerColor() {
    try {
        const saved = localStorage.getItem('omokPlayerColor');
        if (saved === 'black' || saved === 'white') playerColor = saved;
    } catch (e) { /* storage unavailable: keep black */ }
}

function setPlayerColor(color) {
    playerColor = color;
    try { localStorage.setItem('omokPlayerColor', color); } catch (e) { /* not remembered */ }
    document.querySelectorAll('.color-option').forEach(btn => {
        btn.setAttribute('aria-checked', String(btn.dataset.color === color));
    });
}

// ─── XSS Prevention ────────────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function init() {
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.textContent = 'v' + APP_VERSION;

    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');

    stoneAudio = document.getElementById('stoneSound');
    if (stoneAudio) {
        stoneAudio.load();
    }

    calculateCanvasSize();
    loadPlayerColor();
    initBoard();
    bindEvents();
    setPlayerColor(playerColor);
    showScreen('main');
}

function calculateCanvasSize() {
    const maxWidth = Math.min(window.innerWidth - 50, 330);
    CELL_SIZE = Math.floor(maxWidth / BOARD_SIZE);
    CANVAS_SIZE = BOARD_SIZE * CELL_SIZE;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    // The practice status bar matches the board's outer width (canvas + 1px padding + 2px border)
    document.documentElement.style.setProperty('--board-width', `${CANVAS_SIZE + 6}px`);
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    document.getElementById(screenId + 'Screen').classList.remove('hidden');

    if (screenId === 'main') {
        stopIntroAnimation();
        setTimeout(() => startIntroAnimation(), 50);
    } else {
        stopIntroAnimation();
    }
}

function initBoard() {
    board = [];
    for (let i = 0; i < BOARD_SIZE; i++) {
        board[i] = [];
        for (let j = 0; j < BOARD_SIZE; j++) {
            board[i][j] = EMPTY;
        }
    }
    currentPlayer = playerColor === 'black' ? PLAYER : AI;
    gameOver = false;
    levelStones = 0;
    levelStartTime = Date.now();
    lastMove = null;
    moveHistory = [];
    gameSerial++;
    engineWaited = false;

    clearJevGhosts();
    setWinRate(null);
    updateStatus();
    drawBoard();
}

// New board for a game or level; the AI opens when it plays black.
function startBoard() {
    initBoard();
    if (currentPlayer === AI) aiTurn();
}

// ─── Status Bar ────────────────────────────────────────────────────────────────
// Practice: lights only (whose turn, move number). Challenge: the turn as text.
// Both show the AI / Jev lights.
function updateStatus() {
    const bar = document.getElementById('statusBar');
    if (!bar) return;
    const compact = gameMode === 'practice';
    bar.classList.toggle('compact', compact);
    document.getElementById('turnDots').classList.toggle('hidden', !compact);
    if (compact) {
        const blackToMove = !gameOver && isBlackStone(currentPlayer);
        const whiteToMove = !gameOver && !isBlackStone(currentPlayer);
        document.getElementById('blackTurnDot').dataset.state = blackToMove ? 'on' : 'off';
        document.getElementById('whiteTurnDot').dataset.state = whiteToMove ? 'on' : 'off';
        document.getElementById('moveCount').textContent = `${moveHistory.length}수`;
    } else if (gameOver) {
        document.getElementById('turn').textContent = '게임 종료';
    } else {
        document.getElementById('turn').textContent = currentPlayer === PLAYER
            ? `당신의 차례 (${playerColor === 'black' ? '흑' : '백'})`
            : 'AI 생각 중...';
    }
}

// ─── Jev Ghost Stones ──────────────────────────────────────────────────────────
// Shows Jev's judgement on the board (practice mode): translucent white stones on
// the engine's candidates while Jev thinks, then each candidate's probability.
// Ghosts disappear as soon as the AI places its stone.
let jevGhosts = null; // { phase: 'thinking' | 'done', candidates, probabilities, engineMove, move }
let lastAnalysis = null;   // engine analysis behind the current AI move (see chooseAIMove)
let lastJevOutcome = null; // Jev's win probabilities for the current AI move, if it answered

function sameCell(a, b) {
    return !!a && !!b && a.row === b.row && a.col === b.col;
}

// Two small dots in the status box: lit while that part is working.
// state: 'off' | 'on' | 'error' (Jev only: the last request failed)
function setEngineDot(id, state) {
    const el = document.getElementById(id);
    if (el) el.dataset.state = state;
}

function clearJevGhosts() {
    jevGhosts = null;
    setEngineDot('aiDot', 'off');
    setEngineDot('jevDot', 'off');
}

function handleJevUpdate(info) {
    if (info.state === 'engine') {
        setEngineDot('aiDot', 'on');
        return;
    }
    lastAnalysis = info.analysis || null;
    setEngineDot('aiDot', 'off');
    if (info.state === 'thinking') {
        jevGhosts = { phase: 'thinking', candidates: info.candidates, engineMove: info.engineMove };
        setEngineDot('jevDot', 'on');
    } else if (info.state === 'done') {
        lastJevOutcome = info.outcome || null;
        jevGhosts = {
            phase: 'done', candidates: info.candidates, probabilities: info.probabilities,
            engineMove: info.engineMove, move: info.move, safetyMargin: info.safetyMargin,
        };
    } else {
        // forced: the engine decided alone; fallback / paused: Jev did not answer
        jevGhosts = null;
        setEngineDot('jevDot', info.state === 'forced' ? 'off' : 'error');
    }
    drawBoard();
}

// Ghosts are deliberately unlike stones: a small dashed teal ring with the
// percentage inside, no fill. Solid blue ring = engine's first choice,
// dashed red ring = outside the safety margin.
const GHOST_COLOR = '#4fd1c5';
const JEV_REVEAL_MS = 450; // how long Jev's percentages stay up before the AI stone lands

function drawJevGhosts() {
    if (!jevGhosts) return;
    const { phase, candidates, probabilities, engineMove } = jevGhosts;
    const best = candidates[0];
    const radius = CELL_SIZE * 0.36;
    const pOf = c => {
        const hit = (probabilities || []).find(p => p.row === c.row && p.col === c.col);
        return hit ? hit.p : 0;
    };

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.max(8, Math.round(CELL_SIZE * 0.36))}px sans-serif`;
    for (const c of candidates) {
        if (board[c.row][c.col] !== EMPTY) continue;
        const x = CELL_SIZE / 2 + c.col * CELL_SIZE;
        const y = CELL_SIZE / 2 + c.row * CELL_SIZE;
        const p = pOf(c);
        const isEngine = sameCell(c, engineMove);
        const margin = jevGhosts.safetyMargin != null ? jevGhosts.safetyMargin : JEV_CONFIG.safetyMargin;
        const excluded = phase === 'done' && c.score < best.score - margin;
        const color = excluded ? '#d07070' : isEngine ? '#7fa8d6' : GHOST_COLOR;

        // Dark backing hides the grid lines under the number
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = '#1a1a1a';
        ctx.fill();

        ctx.globalAlpha = phase === 'thinking' ? 0.6 : 0.45 + 0.55 * Math.min(1, p * 2);
        ctx.setLineDash(isEngine && !excluded ? [] : [2, 2]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = color;
        ctx.fillText(phase === 'thinking' ? '?' : String(Math.round(p * 100)), x, y + 0.5);
        ctx.globalAlpha = 1;
    }
    ctx.restore();
}

// ─── Win Probability Bar ───────────────────────────────────────────────────────
// After each AI move: Jev's own estimate when Jev answered, otherwise the
// engine's search score mapped through a logistic curve (an estimate, not a
// calibrated probability). Proven wins/losses show 100.0 / 0.0.
const ENGINE_WIN_SCALE = 6000;

// The AI's win rate for a MiniMax score (scores are from the AI's point of view)
function engineAiWinRate(score) {
    if (score >= CERTAIN_WIN) return 1;
    if (score <= -CERTAIN_WIN) return 0;
    const p = 1 / (1 + Math.exp(-score / ENGINE_WIN_SCALE));
    return Math.min(0.999, Math.max(0.001, p));
}

// Shown next to the turn lights in the practice status bar; `source` (where the
// estimate came from) goes into the tooltip
function setWinRate(white, source) {
    const blackEl = document.getElementById('winBlack');
    const whiteEl = document.getElementById('winWhite');
    if (!blackEl || !whiteEl) return;
    blackEl.textContent = white == null ? '-' : `${((1 - white) * 100).toFixed(1)}%`;
    whiteEl.textContent = white == null ? '-' : `${(white * 100).toFixed(1)}%`;
    document.getElementById('turnDots').title = white == null ? '승률: AI가 두면 표시' : `승률: ${source}`;
}

function updateWinRate(jevOutcome, analysis, move) {
    if (analysis && analysis.engine === 'rapfi') {
        // Rapfi's own estimate for the move actually played (Jev may have picked another)
        const played = analysis.candidates.find(c => sameCell(c, move)) || analysis.candidates[0];
        if (played) {
            const winner = (played.mate > 0) === (aiColor() === 'white') ? '백' : '흑';
            setWinRate(aiToWhite(played.winrate), played.mate != null
                ? `Rapfi 확정 · ${Math.abs(played.mate)}수 안에 ${winner} 승`
                : `Rapfi 평가 · ${analysis.depth}수 탐색`);
        }
    } else if (jevOutcome) {
        setWinRate(jevOutcome.white, 'Jev 판단');
    } else if (typeof searchStats !== 'undefined' && searchStats.depth > 0) {
        setWinRate(aiToWhite(engineAiWinRate(lastRootScore)), `엔진 추정 · ${searchStats.depth}수 탐색`);
    }
    // No search ran (opening move or a single forced reply): keep the last value
}

// Mode label shows which engine is playing and Rapfi's download progress
function updateEngineLabel() {
    const el = document.getElementById('modeLabel');
    if (!el) return;
    let text = gameMode === 'practice' ? '연습 모드' : '챌린지 모드';
    if (typeof rapfiState !== 'undefined' && rapfiActive(gameMode)) {
        if (rapfiState.status === 'ready') text += ' · Rapfi';
        else if (rapfiState.status === 'loading') text += ` · Rapfi 불러오는 중 ${Math.round(rapfiState.progress * 100)}%`;
        else if (rapfiState.status === 'failed') text += ' · 기본 엔진';
    }
    el.textContent = text;
}

function drawBoard() {
    if (typeof BoardRenderer !== 'undefined') {
        BoardRenderer.drawBoard(ctx, CELL_SIZE, BOARD_SIZE);
    } else {
        ctx.fillStyle = '#2a2a2a';
        ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.strokeStyle = '#404040';
        ctx.lineWidth = 1;
        const offset = CELL_SIZE / 2;
        for (let i = 0; i < BOARD_SIZE; i++) {
            ctx.beginPath();
            ctx.moveTo(offset, offset + i * CELL_SIZE);
            ctx.lineTo(CANVAS_SIZE - offset, offset + i * CELL_SIZE);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(offset + i * CELL_SIZE, offset);
            ctx.lineTo(offset + i * CELL_SIZE, CANVAS_SIZE - offset);
            ctx.stroke();
        }
        const starPoints = [[3,3],[3,7],[3,11],[7,3],[7,7],[7,11],[11,3],[11,7],[11,11]];
        ctx.fillStyle = '#505050';
        starPoints.forEach(([x, y]) => {
            ctx.beginPath();
            ctx.arc(offset + x * CELL_SIZE, offset + y * CELL_SIZE, 2, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    for (let i = 0; i < BOARD_SIZE; i++) {
        for (let j = 0; j < BOARD_SIZE; j++) {
            if (board[i][j] !== EMPTY) {
                const isLast = lastMove && lastMove.row === i && lastMove.col === j;
                drawStone(i, j, isBlackStone(board[i][j]) ? PLAYER : AI, isLast);
            }
        }
    }
    drawJevGhosts();
}

// `player`: PLAYER draws a black stone, AI a white one (callers map sides to colors)
function drawStone(row, col, player, isLast = false) {
    if (typeof BoardRenderer !== 'undefined') {
        BoardRenderer.drawStone(ctx, row, col, player, CELL_SIZE, isLast);
    } else {
        const x = CELL_SIZE / 2 + col * CELL_SIZE;
        const y = CELL_SIZE / 2 + row * CELL_SIZE;
        const radius = CELL_SIZE / 2 - 2;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        if (player === PLAYER) {
            const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
            gradient.addColorStop(0, '#1a1a1a');
            gradient.addColorStop(1, '#000000');
            ctx.fillStyle = gradient;
            ctx.strokeStyle = '#808080';
        } else {
            const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(1, '#c0c0c0');
            ctx.fillStyle = gradient;
            ctx.strokeStyle = '#909090';
        }
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (isLast) {
            ctx.beginPath();
            ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
            ctx.strokeStyle = player === PLAYER ? '#ffffff' : '#000000';
            ctx.lineWidth = 3;
            ctx.stroke();
        }
    }
}

function drawIntroStone(ctx, x, y, radius, player) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (player === PLAYER) {
        const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
        gradient.addColorStop(0, '#1a1a1a');
        gradient.addColorStop(1, '#000000');
        ctx.fillStyle = gradient;
        ctx.strokeStyle = '#808080';
    } else {
        const gradient = ctx.createRadialGradient(x - 2, y - 2, 0, x, y, radius);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#c0c0c0');
        ctx.fillStyle = gradient;
        ctx.strokeStyle = '#909090';
    }
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

function startIntroAnimation() {
    const introCanvas = document.getElementById('introBoard');
    if (!introCanvas) return;

    const introCtx = introCanvas.getContext('2d');
    const introCellSize = 28;
    const introBoardSize = 9;
    const introCanvasSize = introBoardSize * introCellSize;

    introCanvas.width = introCanvasSize;
    introCanvas.height = introCanvasSize;

    const introStones = [];
    const patterns = [
        [4, 4], [3, 4], [4, 3], [5, 3], [3, 5],
        [4, 5], [5, 4], [6, 4], [5, 5], [6, 5],
        [2, 4], [2, 3], [3, 3], [6, 3], [7, 3]
    ];

    let stoneIndex = 0;
    let lastTime = 0;
    const interval = 1000;

    function drawIntroBoard() {
        introCtx.clearRect(0, 0, introCanvasSize, introCanvasSize);
        introCtx.strokeStyle = '#404040';
        introCtx.lineWidth = 1;
        const offset = introCellSize / 2;
        for (let i = 0; i < introBoardSize; i++) {
            introCtx.beginPath();
            introCtx.moveTo(offset, offset + i * introCellSize);
            introCtx.lineTo(introCanvasSize - offset, offset + i * introCellSize);
            introCtx.stroke();
            introCtx.beginPath();
            introCtx.moveTo(offset + i * introCellSize, offset);
            introCtx.lineTo(offset + i * introCellSize, introCanvasSize - offset);
            introCtx.stroke();
        }
        introCtx.fillStyle = '#505050';
        introCtx.beginPath();
        introCtx.arc(offset + 4 * introCellSize, offset + 4 * introCellSize, 3, 0, Math.PI * 2);
        introCtx.fill();
        introStones.forEach((stone) => {
            const x = offset + stone.col * introCellSize;
            const y = offset + stone.row * introCellSize;
            drawIntroStone(introCtx, x, y, introCellSize / 2 - 2, stone.player);
        });
    }

    function animate(currentTime) {
        if (!lastTime) lastTime = currentTime;
        if (currentTime - lastTime >= interval) {
            if (stoneIndex < patterns.length) {
                introStones.push({
                    row: patterns[stoneIndex][0],
                    col: patterns[stoneIndex][1],
                    player: stoneIndex % 2 === 0 ? PLAYER : AI
                });
                stoneIndex++;
                lastTime = currentTime;
            } else {
                introStones.length = 0;
                stoneIndex = 0;
            }
        }
        drawIntroBoard();
        introAnimationId = requestAnimationFrame(animate);
    }

    introAnimationId = requestAnimationFrame(animate);
}

function stopIntroAnimation() {
    if (introAnimationId) {
        cancelAnimationFrame(introAnimationId);
        introAnimationId = null;
    }
}

function getGridPosition(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    const col = Math.round((x - CELL_SIZE / 2) / CELL_SIZE);
    const row = Math.round((y - CELL_SIZE / 2) / CELL_SIZE);

    return { row, col };
}

function isValidMove(row, col) {
    return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE && board[row][col] === EMPTY;
}

function playStoneSound() {
    if (!stoneAudio) return;
    try {
        stoneAudio.currentTime = 0;
        stoneAudio.play().catch(() => {});
    } catch (e) {}
}

function calculateLevelScore() {
    const config = LEVEL_CONFIG[currentLevel];
    const baseScore = config.baseScore;
    const timeElapsed = Math.floor((Date.now() - levelStartTime) / 1000);
    const timeBonus = Math.max(0, 60 - timeElapsed) * 2;
    const stoneBonus = Math.max(0, 30 - levelStones) * 3;
    const levelMultiplier = 1 + (currentLevel - 1) * 0.1;
    const finalScore = Math.floor((baseScore + timeBonus + stoneBonus) * levelMultiplier);
    return { base: baseScore, timeBonus, stoneBonus, total: finalScore };
}

function startTimer() {
    stopTimer(); // Always clear existing timer first
    elapsedSeconds = 0;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
        elapsedSeconds++;
        updateTimerDisplay();
    }, 1000);
}

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateTimerDisplay() {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    document.getElementById('timeDisplay').textContent =
        `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function updateScoreDisplay() {
    if (gameMode === 'challenge') {
        document.getElementById('scoreDisplay').textContent = totalScore;
    }
    document.getElementById('stoneDisplay').textContent = totalStones;
}

function checkWin(row, col, player) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [dr, dc] of directions) {
        let count = 1;
        let r = row + dr, c = col + dc;
        while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === player) {
            count++; r += dr; c += dc;
        }
        r = row - dr; c = col - dc;
        while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[r][c] === player) {
            count++; r -= dr; c -= dc;
        }
        if (count >= 5) return true;
    }
    return false;
}

function isBoardFull() {
    for (let i = 0; i < BOARD_SIZE; i++) {
        for (let j = 0; j < BOARD_SIZE; j++) {
            if (board[i][j] === EMPTY) return false;
        }
    }
    return true;
}

function makeMove(row, col, player) {
    board[row][col] = player;
    lastMove = { row, col };
    moveHistory.push({ row, col, player });
    if (player === PLAYER) {
        clearJevGhosts();
        levelStones++;
        totalStones++;
        updateScoreDisplay();
        if (!timerInterval) {
            startTimer();
        }
    }

    currentPlayer = player === PLAYER ? AI : PLAYER;
    playStoneSound();
    drawBoard();
    updateStatus();

    if (checkWin(row, col, player)) {
        gameOver = true;
        updateStatus();
        stopTimer();
        saveGameRecord(player);
        if (player === PLAYER) {
            if (gameMode === 'challenge') {
                const scoreInfo = calculateLevelScore();
                totalScore += scoreInfo.total;
                updateScoreDisplay();
                if (currentLevel < 10) {
                    document.getElementById('levelScore').innerHTML =
                        `기본: ${scoreInfo.base}점<br>` +
                        `시간 보너스: +${scoreInfo.timeBonus}점<br>` +
                        `돌 보너스: +${scoreInfo.stoneBonus}점<br>` +
                        `<strong>획득 점수: ${scoreInfo.total}점</strong>`;
                    document.getElementById('nextLevelModal').classList.add('show');
                } else {
                    showFinalResult(true);
                }
            } else {
                showFinalResult(true);
            }
        } else {
            showFinalResult(false);
        }
        return true;
    }

    if (isBoardFull()) {
        gameOver = true;
        updateStatus();
        stopTimer();
        saveGameRecord(0);
        showFinalResult(false, true);
        return true;
    }

    return false;
}

function aiTurn() {
    if (gameOver) return;
    currentPlayer = AI;
    updateStatus();
    setEngineDot('aiDot', 'on');
    const serial = gameSerial;
    if (typeof jevListener !== 'undefined') {
        jevListener = info => { if (serial === gameSerial) handleJevUpdate(info); };
    }
    setTimeout(async () => {
        // Challenge levels are tuned for Rapfi: give a download in progress one wait per
        // board, and keep that wait out of the level time used for the score
        if (gameMode === 'challenge' && !engineWaited && typeof rapfiWaitReady === 'function' && rapfiActive('challenge')) {
            engineWaited = true;
            const waitStart = Date.now();
            await rapfiWaitReady(CHALLENGE_ENGINE_WAIT_MS);
            if (serial !== gameSerial || gameOver) return;
            levelStartTime += Date.now() - waitStart;
        }
        const timeLimit = gameMode === 'challenge' ? LEVEL_CONFIG[currentLevel].timeLimit : 700;
        lastJevOutcome = null;
        lastAnalysis = null;
        const move = await chooseAIMove(board, timeLimit, gameMode, lastMove, {
            level: gameMode === 'challenge' ? currentLevel : null,
            aiColor: aiColor(),
        });
        // A new game may have started while Jev was answering
        if (serial !== gameSerial || gameOver) return;
        if (gameMode === 'practice') updateWinRate(lastJevOutcome, lastAnalysis, move);
        // Let Jev's percentages show briefly, then the stone replaces the ghosts
        if (jevGhosts && jevGhosts.phase === 'done') {
            await new Promise(resolve => setTimeout(resolve, JEV_REVEAL_MS));
            if (serial !== gameSerial || gameOver) return;
        }
        jevGhosts = null;
        setEngineDot('aiDot', 'off');
        if (document.getElementById('jevDot').dataset.state === 'on') setEngineDot('jevDot', 'off');
        if (move) {
            makeMove(move.row, move.col, AI);
        } else {
            drawBoard();
        }
        if (!gameOver) {
            currentPlayer = PLAYER;
            updateStatus();
        }
    }, 300);
}

function handleClick(e) {
    if (gameOver || currentPlayer !== PLAYER) return;
    e.preventDefault();
    const { row, col } = getGridPosition(e);
    if (isValidMove(row, col)) {
        if (!makeMove(row, col, PLAYER)) {
            currentPlayer = AI;
            aiTurn();
        }
    }
}

function handleTouch(e) {
    if (gameOver || currentPlayer !== PLAYER) return;
    e.preventDefault();
    touchHandled = true;
    const { row, col } = getGridPosition(e);
    if (isValidMove(row, col)) {
        if (!makeMove(row, col, PLAYER)) {
            currentPlayer = AI;
            aiTurn();
        }
    }
}

function handleClickSafe(e) {
    // Skip if this click was already handled by touchstart
    if (touchHandled) {
        touchHandled = false;
        return;
    }
    handleClick(e);
}

function showFinalResult(isWin, isDraw = false) {
    const resultTitle = document.getElementById('resultTitle');
    const resultDetails = document.getElementById('resultDetails');
    const retryBtn = document.getElementById('retryBtn');
    const saveBtn = document.getElementById('saveResultBtn');

    if (isDraw) {
        resultTitle.textContent = '무승부';
        resultTitle.className = 'result-title draw';
    } else if (isWin) {
        if (gameMode === 'challenge' && currentLevel === 10) {
            resultTitle.textContent = '모든 단계 클리어!';
            resultTitle.className = 'result-title clear';
        } else {
            resultTitle.textContent = '승리';
            resultTitle.className = 'result-title win';
        }
    } else {
        resultTitle.textContent = '패배';
        resultTitle.className = 'result-title lose';
    }

    // XSS-safe rendering with escapeHtml
    if (gameMode === 'challenge') {
        const safeName = escapeHtml(playerName || '익명');
        resultDetails.innerHTML = `
            <div class="result-row"><span class="label">플레이어</span><span class="value">${safeName}</span></div>
            <div class="result-row"><span class="label">도달 단계</span><span class="value">${currentLevel}단계</span></div>
            <div class="result-row"><span class="label">총 점수</span><span class="value">${totalScore}점</span></div>
            <div class="result-row"><span class="label">총 돌 수</span><span class="value">${totalStones}개</span></div>
        `;
        retryBtn.classList.add('hidden');
        saveBtn.classList.remove('hidden');
    } else {
        resultDetails.innerHTML = `
            <div class="result-row"><span class="label">사용 돌 수</span><span class="value">${levelStones}개</span></div>
        `;
        retryBtn.classList.remove('hidden');
        saveBtn.classList.add('hidden');
    }

    document.getElementById('resultModal').classList.add('show');
}

function startPracticeGame() {
    gameMode = 'practice';
    stopTimer(); // Fix: always clear before nulling
    elapsedSeconds = 0;
    totalStones = 0;

    if (typeof loadPatternWeights === 'function') {
        loadPatternWeights();
    }

    startEngineDownload();
    document.getElementById('levelLabel').classList.add('hidden');
    document.getElementById('scoreDisplay').textContent = '-';
    document.getElementById('timeDisplay').textContent = '00:00';
    document.getElementById('stoneDisplay').textContent = '0';
    showScreen('game');
    startBoard();
}

function startChallengeGame() {
    gameMode = 'challenge';
    currentLevel = 1;
    totalScore = 0;
    totalStones = 0;
    elapsedSeconds = 0;
    stopTimer(); // Fix: always clear before nulling

    if (typeof loadPatternWeights === 'function') {
        loadPatternWeights();
    }

    startEngineDownload();
    document.getElementById('levelLabel').classList.remove('hidden');
    document.getElementById('levelLabel').textContent = `${currentLevel}단계 / 10`;
    document.getElementById('scoreDisplay').textContent = '0';
    document.getElementById('timeDisplay').textContent = '00:00';
    document.getElementById('stoneDisplay').textContent = '0';
    showScreen('game');
    startBoard();
}

// Start (or keep) the Rapfi download and show its progress in the mode label
function startEngineDownload() {
    if (typeof rapfiLoad === 'function' && rapfiActive(gameMode)) {
        rapfiListener = updateEngineLabel;
        rapfiLoad();
    }
    updateEngineLabel();
}

function nextLevel() {
    document.getElementById('nextLevelModal').classList.remove('show');
    currentLevel++;
    document.getElementById('levelLabel').textContent = `${currentLevel}단계 / 10`;
    startBoard();
}

function saveToLeaderboard() {
    const data = {
        name: playerName || '익명',
        score: totalScore,
        level: currentLevel,
        stones: totalStones,
        date: new Date().toISOString().split('T')[0]
    };

    fetch('/api/leaderboard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(res => {
        if (!res.ok) throw new Error('Server error');
        return res.json();
    })
    .then(() => {
        document.getElementById('resultModal').classList.remove('show');
        stopTimer();
        showScreen('main');
    })
    .catch(err => {
        console.error('Error saving:', err);
        document.getElementById('resultModal').classList.remove('show');
        stopTimer();
        showScreen('main');
    });
}

function renderLeaderboard() {
    fetch('/api/leaderboard')
        .then(res => {
            if (!res.ok) throw new Error('Server error');
            return res.json();
        })
        .then(leaderboard => {
            const rankList = document.getElementById('rankList');

            if (!leaderboard || leaderboard.length === 0) {
                rankList.innerHTML = '<div class="empty-rank">아직 기록이 없습니다</div>';
                return;
            }

            // XSS-safe rendering
            rankList.innerHTML = leaderboard.map((entry, index) => `
                <div class="rank-item ${index < 3 ? 'top3' : ''}">
                    <span class="rank-position">${index + 1}</span>
                    <span class="rank-name">${escapeHtml(entry.name)}</span>
                    <span class="rank-score">${entry.score}</span>
                    <span class="rank-level">${entry.level}단계</span>
                    <span class="rank-date">${escapeHtml(entry.date)}</span>
                </div>
            `).join('');
        })
        .catch(err => {
            console.error('Error loading leaderboard:', err);
            document.getElementById('rankList').innerHTML = '<div class="empty-rank">아직 기록이 없습니다</div>';
        });
}

function bindEvents() {
    document.getElementById('practiceBtn').addEventListener('click', () => {
        showScreen('setup');
        if (typeof rapfiLoad === 'function') rapfiLoad(); // download while the player picks
    });
    document.getElementById('startPracticeBtn').addEventListener('click', startPracticeGame);
    document.getElementById('backFromSetupBtn').addEventListener('click', () => showScreen('main'));

    document.querySelectorAll('.color-option').forEach(btn => {
        btn.addEventListener('click', () => setPlayerColor(btn.dataset.color));
    });

    document.getElementById('challengeBtn').addEventListener('click', () => {
        if (typeof rapfiLoad === 'function') rapfiLoad();
        showScreen('id');
        document.getElementById('playerId').value = '';
        document.getElementById('playerId').focus();
    });

    document.getElementById('rankBtn').addEventListener('click', () => {
        renderLeaderboard();
        showScreen('rank');
    });

    document.getElementById('startChallengeBtn').addEventListener('click', () => {
        playerName = document.getElementById('playerId').value.trim() || '익명';
        startChallengeGame();
    });

    document.getElementById('backFromIdBtn').addEventListener('click', () => {
        showScreen('main');
    });

    document.getElementById('backFromRankBtn').addEventListener('click', () => {
        showScreen('main');
    });

    document.getElementById('surrenderBtn').addEventListener('click', () => {
        gameOver = true;
        updateStatus();
        stopTimer(); // Fix: always stop timer on surrender
        if (gameMode === 'challenge') {
            showFinalResult(false);
        } else {
            showScreen('main');
        }
    });

    document.getElementById('exitGameBtn').addEventListener('click', () => {
        gameOver = true;
        stopTimer();
        if (gameMode === 'challenge') {
            showFinalResult(false);
        } else {
            showScreen('main');
        }
    });

    document.getElementById('nextLevelBtn').addEventListener('click', nextLevel);
    document.getElementById('saveResultBtn').addEventListener('click', saveToLeaderboard);

    document.getElementById('retryBtn').addEventListener('click', () => {
        document.getElementById('resultModal').classList.remove('show');
        if (gameMode === 'practice') {
            startPracticeGame();
        } else {
            startChallengeGame();
        }
    });

    document.getElementById('homeBtn').addEventListener('click', () => {
        document.getElementById('resultModal').classList.remove('show');
        stopTimer();
        showScreen('main');
    });

    document.getElementById('playerId').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('startChallengeBtn').click();
        }
    });

    // Fix: separate touch and click handlers to prevent double-fire
    canvas.addEventListener('click', handleClickSafe);
    canvas.addEventListener('touchstart', handleTouch, { passive: false });

    window.addEventListener('resize', () => {
        calculateCanvasSize();
        drawBoard();
    });
}

function saveGameRecord(winner) {
    const data = {
        moves: moveHistory,
        winner: winner,
        gameMode: gameMode,
        level: currentLevel,
        playerColor: playerColor
    };

    fetch('/api/game-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(res => {
        if (!res.ok) throw new Error('Server error');
        return res.json();
    })
    .then(result => {
        if (result.learned) {
            console.log('AI learned:', result.attack_patterns, 'attack,', result.defense_patterns, 'defense,', result.composites, 'composites');
        }
    })
    .catch(err => console.error('Error saving game record:', err));
}

document.addEventListener('DOMContentLoaded', init);
