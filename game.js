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
let playerName = '';
let currentLevel = 1;
let totalScore = 0;
let levelStartTime = 0;
let totalStones = 0;
let levelStones = 0;
let timerInterval = null;
let elapsedSeconds = 0;
let introAnimationId = null;

const LEVEL_CONFIG = {
    1: { depth: 1, baseScore: 100 },
    2: { depth: 1, baseScore: 150 },
    3: { depth: 1, baseScore: 200 },
    4: { depth: 2, baseScore: 300 },
    5: { depth: 2, baseScore: 400 },
    6: { depth: 2, baseScore: 500 },
    7: { depth: 2, baseScore: 650 },
    8: { depth: 3, baseScore: 850 },
    9: { depth: 3, baseScore: 1100 },
    10: { depth: 3, baseScore: 1500 }
};

let canvas, ctx;
let stoneAudio = null;

function init() {
    canvas = document.getElementById('board');
    ctx = canvas.getContext('2d');
    
    stoneAudio = document.getElementById('stoneSound');
    if (stoneAudio) {
        stoneAudio.load();
    }
    
    calculateCanvasSize();
    initBoard();
    bindEvents();
    showScreen('main');
}

function calculateCanvasSize() {
    const maxWidth = Math.min(window.innerWidth - 50, 330);
    CELL_SIZE = Math.floor(maxWidth / BOARD_SIZE);
    CANVAS_SIZE = BOARD_SIZE * CELL_SIZE;
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
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
    currentPlayer = PLAYER;
    gameOver = false;
    levelStones = 0;
    levelStartTime = Date.now();
    
    const turnEl = document.getElementById('turn');
    if (turnEl) turnEl.textContent = '당신의 차례 (흑)';
    
    drawBoard();
}

function drawBoard() {
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
    
    const starPoints = [[3, 3], [3, 7], [3, 11], [7, 3], [7, 7], [7, 11], [11, 3], [11, 7], [11, 11]];
    ctx.fillStyle = '#505050';
    starPoints.forEach(([x, y]) => {
        ctx.beginPath();
        ctx.arc(offset + x * CELL_SIZE, offset + y * CELL_SIZE, 2, 0, Math.PI * 2);
        ctx.fill();
    });
    
    for (let i = 0; i < BOARD_SIZE; i++) {
        for (let j = 0; j < BOARD_SIZE; j++) {
            if (board[i][j] !== EMPTY) {
                drawStone(i, j, board[i][j]);
            }
        }
    }
}

function drawStone(row, col, player) {
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
    console.log('playStoneSound called, stoneAudio:', stoneAudio);
    if (!stoneAudio) {
        console.log('stoneAudio is null!');
        return;
    }
    
    try {
        console.log('Attempting to play audio...');
        stoneAudio.currentTime = 0;
        stoneAudio.play().then(() => {
            console.log('Audio played successfully');
        }).catch((err) => {
            console.log('Audio play failed:', err);
        });
    } catch (e) {
        console.log('Audio error:', e);
    }
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
    if (player === PLAYER) {
        levelStones++;
        totalStones++;
        updateScoreDisplay();
        
        if (!timerInterval) {
            startTimer();
        }
    }
    
    playStoneSound();
    drawBoard();
    
    if (checkWin(row, col, player)) {
        gameOver = true;
        stopTimer();
        
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
        stopTimer();
        showFinalResult(false, true);
        return true;
    }
    
    return false;
}

function aiTurn() {
    if (gameOver) return;
    
    document.getElementById('turn').textContent = 'AI 생각 중...';
    
    setTimeout(() => {
        const depth = gameMode === 'challenge' ? LEVEL_CONFIG[currentLevel].depth : 2;
        const move = getAIMove(board, depth);
        
        if (move) {
            makeMove(move.row, move.col, AI);
        }
        
        if (!gameOver) {
            currentPlayer = PLAYER;
            document.getElementById('turn').textContent = '당신의 차례 (흑)';
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
    
    if (gameMode === 'challenge') {
        resultDetails.innerHTML = `
            <div class="result-row"><span class="label">플레이어</span><span class="value">${playerName || '익명'}</span></div>
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
    timerInterval = null;
    elapsedSeconds = 0;
    totalStones = 0;
    
    document.getElementById('modeLabel').textContent = '연습 모드';
    document.getElementById('levelLabel').classList.add('hidden');
    document.getElementById('scoreDisplay').textContent = '-';
    document.getElementById('timeDisplay').textContent = '00:00';
    document.getElementById('stoneDisplay').textContent = '0';
    initBoard();
    showScreen('game');
}

function startChallengeGame() {
    gameMode = 'challenge';
    currentLevel = 1;
    totalScore = 0;
    totalStones = 0;
    elapsedSeconds = 0;
    timerInterval = null;
    
    document.getElementById('modeLabel').textContent = '챌린지 모드';
    document.getElementById('levelLabel').classList.remove('hidden');
    document.getElementById('levelLabel').textContent = `${currentLevel}단계 / 10`;
    document.getElementById('scoreDisplay').textContent = '0';
    document.getElementById('timeDisplay').textContent = '00:00';
    document.getElementById('stoneDisplay').textContent = '0';
    initBoard();
    showScreen('game');
}

function nextLevel() {
    document.getElementById('nextLevelModal').classList.remove('show');
    currentLevel++;
    document.getElementById('levelLabel').textContent = `${currentLevel}단계 / 10`;
    initBoard();
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
        .then(res => res.json())
        .then(leaderboard => {
            const rankList = document.getElementById('rankList');
            
            if (!leaderboard || leaderboard.length === 0) {
                rankList.innerHTML = '<div class="empty-rank">아직 기록이 없습니다</div>';
                return;
            }
            
            rankList.innerHTML = leaderboard.map((entry, index) => `
                <div class="rank-item ${index < 3 ? 'top3' : ''}">
                    <span class="rank-position">${index + 1}</span>
                    <span class="rank-name">${entry.name}</span>
                    <span class="rank-score">${entry.score}</span>
                    <span class="rank-level">${entry.level}단계</span>
                    <span class="rank-date">${entry.date}</span>
                </div>
            `).join('');
        })
        .catch(err => {
            console.error('Error loading leaderboard:', err);
            document.getElementById('rankList').innerHTML = '<div class="empty-rank">아직 기록이 없습니다</div>';
        });
}

function bindEvents() {
    document.getElementById('practiceBtn').addEventListener('click', startPracticeGame);
    
    document.getElementById('challengeBtn').addEventListener('click', () => {
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
        if (gameMode === 'challenge') {
            gameOver = true;
            stopTimer();
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
    
    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('touchstart', handleClick, { passive: false });
    
    window.addEventListener('resize', () => {
        calculateCanvasSize();
        drawBoard();
    });
}

document.addEventListener('DOMContentLoaded', init);
