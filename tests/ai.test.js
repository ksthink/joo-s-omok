// Tactical tests for ai.js. Run with: node --test tests/ai.test.js
// ai.js is a browser global script, so it is loaded into a vm context.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AI = 2, HUMAN = 1;

function loadAI() {
    const noop = () => {};
    const ctx = vm.createContext({
        console: { log: noop, warn: noop, error: noop, info: noop },
        fetch: async () => ({ ok: false }),
    });
    const file = process.env.JOO_AI_PATH || path.join(__dirname, '..', 'ai.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    return ctx;
}

const ai = loadAI();

function makeBoard({ human = [], ai: aiStones = [] }) {
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    for (const [r, c] of human) b[r][c] = HUMAN;
    for (const [r, c] of aiStones) b[r][c] = AI;
    return b;
}

function show(board, mark) {
    const rows = ['   ' + [...Array(15).keys()].map(c => (c % 10).toString()).join(' ')];
    for (let r = 0; r < 15; r++) {
        let s = String(r).padStart(2) + ' ';
        for (let c = 0; c < 15; c++) {
            const isMark = mark && mark.row === r && mark.col === c;
            s += (isMark ? '*' : '.XO'[board[r][c]]) + ' ';
        }
        rows.push(s);
    }
    return '\n' + rows.join('\n') + '\n(X = human 1, O = AI 2, * = AI move)';
}

function aiMove(board, ms = 1000) {
    const copy = board.map(r => r.slice());
    const move = ai.getAIMove(copy, ms);
    assert.deepStrictEqual(copy, board, 'getAIMove must leave the board unchanged');
    return move;
}

function expectMove(board, allowed, ms) {
    const move = aiMove(board, ms);
    const ok = move && allowed.some(([r, c]) => move.row === r && move.col === c);
    assert.ok(ok, `expected one of ${JSON.stringify(allowed)}, got ${JSON.stringify(move)}` + show(board, move));
}

test('1. blocks an open three', () => {
    const board = makeBoard({
        human: [[7, 6], [7, 7], [7, 8]],
        ai: [[11, 2], [12, 3]],
    });
    expectMove(board, [[7, 5], [7, 9]]);
});

test('2. blocks a gapped four (OO_OO)', () => {
    const board = makeBoard({
        human: [[7, 5], [7, 6], [7, 8], [7, 9]],
        ai: [[11, 2], [12, 3], [2, 12]],
    });
    expectMove(board, [[7, 7]]);
});

test('3. takes its own five before blocking', () => {
    const board = makeBoard({
        human: [[10, 3], [10, 4], [10, 5], [10, 6], [1, 13]],
        ai: [[3, 4], [3, 5], [3, 6], [3, 7]],
    });
    expectMove(board, [[3, 3], [3, 8]]);
});

test('4. finds the only four-three made with a gapped four', () => {
    // Row 7: X O O O _ [*]  -> (7,7) makes the gapped four OOO_O
    // Col 7: (8,7)(9,7)     -> (7,7) also makes an open three
    const board = makeBoard({
        human: [[7, 2], [2, 2], [2, 12], [12, 12], [12, 2]],
        ai: [[7, 3], [7, 4], [7, 5], [8, 7], [9, 7]],
    });
    const info = ai.classifyMove(board, 7, 7, AI);
    assert.strictEqual(info.fourCount, 1, show(board));
    assert.strictEqual(info.openThreeCount, 1, show(board));
    expectMove(board, [[7, 7]]);
});

test('5. classifyMove shape table', () => {
    // Pattern placed on row 7 starting at column 5; the move is the first 'O'.
    const cases = [
        ['_OOOO_', 'openFour'],
        ['XOOOO_', 'four'],
        ['OO_OO', 'four'],
        ['O_OOO', 'four'],
        ['_O_OO_', 'openThree'],
        ['_OOO_', 'openThree'],
    ];
    for (const [pattern, expected] of cases) {
        const human = [], aiStones = [];
        let move = null;
        [...pattern].forEach((ch, i) => {
            const cell = [7, 5 + i];
            if (ch === 'O') { if (!move) move = cell; else aiStones.push(cell); }
            if (ch === 'X') human.push(cell);
        });
        const board = makeBoard({ human, ai: aiStones });
        const info = ai.classifyMove(board, move[0], move[1], AI);
        const got = info.five ? 'five'
            : info.openFour > 0 ? 'openFour'
            : info.fourCount > 0 ? 'four'
            : info.openThreeCount > 0 ? 'openThree' : 'none';
        assert.strictEqual(got, expected, `${pattern}: ${JSON.stringify(info)}` + show(board));
        const sum = info.openFour + info.fourCount + info.openThreeCount;
        assert.strictEqual(sum, 1, `${pattern} should be counted once: ${JSON.stringify(info)}`);
    }
});

function hasFive(board) {
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
        const p = board[r][c];
        if (!p) continue;
        for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
            let n = 1;
            while (n < 5) {
                const rr = r + dr * n, cc = c + dc * n;
                if (rr < 0 || rr >= 15 || cc < 0 || cc >= 15 || board[rr][cc] !== p) break;
                n++;
            }
            if (n >= 5) return true;
        }
    }
    return false;
}

test('6. respects the time limit on random middle-game positions', () => {
    let seed = 12345;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let worst = 0;
    for (let g = 0; g < 20; g++) {
        let board;
        do {
            board = makeBoard({});
            const stones = 16 + Math.floor(rand() * 20);
            let player = HUMAN;
            for (let i = 0; i < stones; i++) {
                let r, c;
                do {
                    r = 3 + Math.floor(rand() * 9);
                    c = 3 + Math.floor(rand() * 9);
                } while (board[r][c] !== 0);
                board[r][c] = player;
                player = 3 - player;
            }
        } while (hasFive(board));
        const t0 = process.hrtime.bigint();
        const move = aiMove(board, 1000);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        worst = Math.max(worst, ms);
        assert.ok(move && board[move.row][move.col] === 0, 'illegal move' + show(board, move));
        assert.ok(ms <= 1100, `took ${ms.toFixed(0)}ms` + show(board, move));
    }
    test.diagnostic?.(`worst ${worst.toFixed(0)}ms`);
});
