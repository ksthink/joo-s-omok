function getAIMove(board, depth) {
    if (isEmpty(board)) {
        return { row: 7, col: 7 };
    }
    
    const move = findImmediateWin(board, 2);
    if (move) return move;
    
    const blockMove = findImmediateWin(board, 1);
    if (blockMove) return blockMove;
    
    return minimax(board, depth, -Infinity, Infinity, true).move;
}

function isEmpty(board) {
    const size = board.length;
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
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
            if (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) {
                count++;
            } else break;
        }
        
        for (let k = 1; k < 5; k++) {
            const r = row - dr * k;
            const c = col - dc * k;
            if (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === player) {
                count++;
            } else break;
        }
        
        if (count >= 5) return true;
    }
    return false;
}

function minimax(board, depth, alpha, beta, isMaximizing) {
    const score = evaluateBoard(board);
    
    if (depth === 0 || Math.abs(score) >= 100000) {
        return { score: score, move: null };
    }
    
    const moves = getValidMoves(board);
    if (moves.length === 0) {
        return { score: 0, move: null };
    }
    
    let bestMove = moves[0];
    
    if (isMaximizing) {
        let maxScore = -Infinity;
        
        for (const move of moves) {
            board[move.row][move.col] = 2;
            const result = minimax(board, depth - 1, alpha, beta, false);
            board[move.row][move.col] = 0;
            
            if (result.score > maxScore) {
                maxScore = result.score;
                bestMove = move;
            }
            
            alpha = Math.max(alpha, result.score);
            if (beta <= alpha) break;
        }
        
        return { score: maxScore, move: bestMove };
    } else {
        let minScore = Infinity;
        
        for (const move of moves) {
            board[move.row][move.col] = 1;
            const result = minimax(board, depth - 1, alpha, beta, true);
            board[move.row][move.col] = 0;
            
            if (result.score < minScore) {
                minScore = result.score;
                bestMove = move;
            }
            
            beta = Math.min(beta, result.score);
            if (beta <= alpha) break;
        }
        
        return { score: minScore, move: bestMove };
    }
}

function getValidMoves(board) {
    const size = board.length;
    const moves = [];
    const checked = new Set();
    
    for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
            if (board[i][j] !== 0) {
                for (let di = -2; di <= 2; di++) {
                    for (let dj = -2; dj <= 2; dj++) {
                        const ni = i + di;
                        const nj = j + dj;
                        const key = `${ni},${nj}`;
                        
                        if (ni >= 0 && ni < size && nj >= 0 && nj < size && 
                            board[ni][nj] === 0 && !checked.has(key)) {
                            checked.add(key);
                            moves.push({ row: ni, col: nj });
                        }
                    }
                }
            }
        }
    }
    
    moves.sort((a, b) => {
        const scoreA = evaluatePosition(a.row, a.col, board);
        const scoreB = evaluatePosition(b.row, b.col, board);
        return scoreB - scoreA;
    });
    
    return moves.slice(0, 15);
}

function evaluatePosition(row, col, board) {
    let score = 0;
    
    board[row][col] = 2;
    score += evaluatePoint(row, col, 2, board) * 1.1;
    board[row][col] = 0;
    
    board[row][col] = 1;
    score += evaluatePoint(row, col, 1, board);
    board[row][col] = 0;
    
    return score;
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
        totalScore += evaluateLine(line, player);
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

function evaluateLine(line, player) {
    const patterns = [
        { pattern: 'OOOOO', score: 100000 },
        { pattern: '_OOOO_', score: 50000 },
        { pattern: 'OOOO_', score: 10000 },
        { pattern: '_OOOO', score: 10000 },
        { pattern: 'XOOOO_', score: 10000 },
        { pattern: '_OOOOX', score: 10000 },
        { pattern: '_OOO_', score: 5000 },
        { pattern: 'OOO__', score: 1000 },
        { pattern: '__OOO', score: 1000 },
        { pattern: '_O_OO_', score: 1000 },
        { pattern: '_OO_O_', score: 1000 },
        { pattern: 'OO_O_', score: 1000 },
        { pattern: '_O_OO', score: 1000 },
        { pattern: 'OO__', score: 100 },
        { pattern: '__OO', score: 100 },
        { pattern: '_O_O_', score: 100 },
        { pattern: '_OO_', score: 100 },
        { pattern: 'O__', score: 10 },
        { pattern: '__O', score: 10 },
        { pattern: '_O_', score: 10 }
    ];
    
    let score = 0;
    
    for (const { pattern, score: patternScore } of patterns) {
        if (line.includes(pattern)) {
            score += patternScore;
        }
    }
    
    return score;
}
