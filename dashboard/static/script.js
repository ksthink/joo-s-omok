const BOARD_SIZE = 15;
const CELL_SIZE = 22;
const CANVAS_SIZE = BOARD_SIZE * CELL_SIZE;

let canvas, ctx;
let currentMoves = [];
let currentMoveIndex = 0;
let autoPlayInterval = null;
let gamesData = [];
let currentPatterns = [];

// ─── XSS Prevention ────────────────────────────────────────────────────────────
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
}

// ─── Safe Fetch Wrapper ─────────────────────────────────────────────────────────
function safeFetch(url) {
    return fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        });
}

document.addEventListener('DOMContentLoaded', () => {
    initCanvas();
    initTabs();
    loadStats();
    loadLeaderboard();
    loadGames();
    initReplayControls();
});

function initCanvas() {
    canvas = document.getElementById('replayBoard');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    drawEmptyBoard();
}

function initTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            const tabId = tab.dataset.tab;
            document.getElementById(tabId).classList.add('active');
        });
    });
}

// ─── Stats Tab ──────────────────────────────────────────────────────────────────
function loadStats() {
    safeFetch('/dashboard/api/stats')
        .then(data => {
            document.getElementById('totalGames').textContent = data.total_games;
            document.getElementById('winRate').textContent = data.win_rate + '%';
            document.getElementById('playerWins').textContent = data.player_wins;
            document.getElementById('aiWins').textContent = data.ai_wins;
            document.getElementById('practiceGames').textContent = data.practice_games;
            document.getElementById('challengeGames').textContent = data.challenge_games;
            renderDailyStats(data.daily_stats);
        })
        .catch(err => {
            console.error('Error loading stats:', err);
        });
}

function renderDailyStats(dailyStats) {
    const container = document.getElementById('dailyStats');
    if (!dailyStats || dailyStats.length === 0) {
        container.innerHTML = '<div class="empty-message">데이터가 없습니다</div>';
        return;
    }
    const maxCount = Math.max(...dailyStats.map(d => d.count), 1);
    container.innerHTML = dailyStats.map(day => `
        <div class="daily-item">
            <span class="daily-date">${escapeHtml(day.date)}</span>
            <div class="daily-bar">
                <div class="daily-bar-fill" style="width: ${(day.count / maxCount * 100)}%"></div>
            </div>
            <span class="daily-count">${day.count}게임</span>
        </div>
    `).join('');
}

// ─── Leaderboard Tab ────────────────────────────────────────────────────────────
function loadLeaderboard() {
    safeFetch('/dashboard/api/leaderboard')
        .then(data => {
            renderLeaderboard(data);
        })
        .catch(err => {
            console.error('Error loading leaderboard:', err);
        });
}

function renderLeaderboard(leaderboard) {
    const tbody = document.getElementById('leaderboardTable');
    if (!leaderboard || leaderboard.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-message">데이터가 없습니다</td></tr>';
        return;
    }

    tbody.innerHTML = leaderboard.map((entry, index) => {
        const rankClass = index < 3 ? `rank-${index + 1}` : '';
        return `
            <tr>
                <td class="${rankClass}">${index + 1}</td>
                <td>${escapeHtml(entry.name)}</td>
                <td>${entry.score.toLocaleString()}</td>
                <td>${entry.level}단계</td>
                <td>${entry.stones}개</td>
                <td>${escapeHtml(entry.date)}</td>
            </tr>
        `;
    }).join('');
}

// ─── Games / Replay Tab ─────────────────────────────────────────────────────────
function loadGames() {
    safeFetch('/dashboard/api/games')
        .then(data => {
            gamesData = data;
            renderGameSelect(data);
        })
        .catch(err => {
            console.error('Error loading games:', err);
        });
}

function renderGameSelect(games) {
    const select = document.getElementById('gameSelect');
    select.innerHTML = '<option value="">게임을 선택하세요</option>';
    games.forEach(game => {
        const option = document.createElement('option');
        option.value = game.id;
        const timeStr = game.time ? ` ${game.time}` : '';
        option.textContent = `#${game.id} - ${game.date}${timeStr} (${game.game_mode}) - ${game.winner_text}`;
        select.appendChild(option);
    });
}

function initReplayControls() {
    document.getElementById('gameSelect').addEventListener('change', (e) => {
        const gameId = e.target.value;
        if (gameId) {
            loadGameReplay(gameId);
        } else {
            resetReplay();
        }
    });
    document.getElementById('btnFirst').addEventListener('click', () => goToMove(0));
    document.getElementById('btnPrev').addEventListener('click', () => goToMove(currentMoveIndex - 1));
    document.getElementById('btnNext').addEventListener('click', () => goToMove(currentMoveIndex + 1));
    document.getElementById('btnLast').addEventListener('click', () => goToMove(currentMoves.length));
    document.getElementById('btnAuto').addEventListener('click', toggleAutoPlay);
    document.getElementById('showPatternLines').addEventListener('change', () => {
        renderBoard();
    });
}

function loadGameReplay(gameId) {
    Promise.all([
        safeFetch(`/dashboard/api/game/${gameId}`),
        safeFetch(`/dashboard/api/game/${gameId}/patterns`)
    ]).then(([gameData, patternsData]) => {
        currentMoves = gameData.moves || [];
        currentMoveIndex = 0;
        currentPatterns = patternsData.patterns || [];
        const winnerText = gameData.winner === 1 ? '플레이어 승' : (gameData.winner === 2 ? 'AI 승' : 'AI테스트');
        const modeMap = {'practice': '연습게임', 'challenge': '챌린지', 'tested': 'AI테스트'};
        const modeText = modeMap[gameData.game_mode] || gameData.game_mode;
        document.getElementById('replayInfo').textContent =
            `${modeText} | ${gameData.level}단계 | ${gameData.stone_count}수 | ${winnerText} | ${gameData.date}`;
        goToMove(0);
    }).catch(err => {
        console.error('Error loading replay:', err);
    });
}

function resetReplay() {
    currentMoves = [];
    currentMoveIndex = 0;
    currentPatterns = [];
    stopAutoPlay();
    drawEmptyBoard();
    document.getElementById('replayInfo').textContent = '게임을 선택하세요';
    document.getElementById('moveCounter').textContent = '0 / 0';
}

function goToMove(index) {
    if (index < 0) index = 0;
    if (index > currentMoves.length) index = currentMoves.length;
    currentMoveIndex = index;
    renderBoard();
    updateMoveCounter();
}

function renderBoard() {
    drawEmptyBoard();
    for (let i = 0; i < currentMoveIndex; i++) {
        const move = currentMoves[i];
        // Black always moves first (the AI opens when the player picked white)
        drawStone(move.row, move.col, i % 2 === 0 ? 1 : 2, i === currentMoveIndex - 1, i + 1);
    }
    drawPatterns();
}

function drawPatterns() {
    if (!currentPatterns || currentPatterns.length === 0) return;
    const showLines = document.getElementById('showPatternLines');
    if (!showLines || !showLines.checked) return;
    currentPatterns.forEach(pattern => {
        if (pattern.move_index !== undefined && pattern.move_index >= currentMoveIndex) return;
        drawPatternLine(pattern);
    });
}
function drawPatternLine(pattern) {
    const startRow = pattern.start.row;
    const startCol = pattern.start.col;
    const endRow = pattern.end.row;
    const endCol = pattern.end.col;
    const offset = CELL_SIZE / 2;
    const x1 = offset + startCol * CELL_SIZE;
    const y1 = offset + startRow * CELL_SIZE;
    const x2 = offset + endCol * CELL_SIZE;
    const y2 = offset + endRow * CELL_SIZE;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    if (pattern.is_composite) {
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
    } else {
        ctx.strokeStyle = 'rgba(255, 99, 71, 0.5)';
    }
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
}

// ─── Board Drawing (uses shared BoardRenderer if available) ─────────────────────
function drawEmptyBoard() {
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
}

// player: 1 draws a black stone, 2 a white one
function drawStone(row, col, player, isLast, moveNumber) {
    const x = CELL_SIZE / 2 + col * CELL_SIZE;
    const y = CELL_SIZE / 2 + row * CELL_SIZE;
    const radius = CELL_SIZE / 2 - 2;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    if (player === 1) {
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
        ctx.strokeStyle = player === 1 ? '#ffffff' : '#000000';
        ctx.lineWidth = 3;
        ctx.stroke();
    }
    if (moveNumber !== undefined) {
        const fontSize = 9;
        ctx.font = `bold ${fontSize}px GameFont`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = player === 1 ? '#ffffff' : '#000000';
        ctx.fillText(moveNumber.toString(), x, y);
    }
}

function updateMoveCounter() {
    document.getElementById('moveCounter').textContent = `${currentMoveIndex} / ${currentMoves.length}`;
}

function toggleAutoPlay() {
    const btn = document.getElementById('btnAuto');
    if (autoPlayInterval) {
        stopAutoPlay();
    } else {
        btn.textContent = '정지';
        autoPlayInterval = setInterval(() => {
            if (currentMoveIndex < currentMoves.length) {
                goToMove(currentMoveIndex + 1);
            } else {
                stopAutoPlay();
            }
        }, 500);
    }
}

function stopAutoPlay() {
    if (autoPlayInterval) {
        clearInterval(autoPlayInterval);
        autoPlayInterval = null;
    }
    document.getElementById('btnAuto').textContent = '자동재생';
}
