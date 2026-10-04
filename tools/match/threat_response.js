#!/usr/bin/env node
// Open-three response rate from match JSONL files.
// usage: node tools/match/threat_response.js FILE.jsonl [...]
// For every move, if the opponent could make an open four on its next move
// (i.e. it has an open three), the move counts as a response when it makes a
// four/five itself or leaves the opponent with no open-four point.
// Uses classifyMove from ai.js (loaded in a vm context).
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ctx = vm.createContext({ console: { log() {} }, fetch: async () => ({ ok: false }) });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', '..', 'ai.js'), 'utf8'), ctx);

function openFourPoints(board, player) {
    let n = 0;
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
        if (board[r][c] === 0 && ctx.classifyMove(board, r, c, player).openFour > 0) n++;
    }
    return n;
}

const tally = { joo: [0, 0], opp: [0, 0] }; // [faced, responded]
for (const file of process.argv.slice(2)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const g = JSON.parse(line);
        const jooColor = g.joo_color === 'B' ? 1 : 2;
        const board = Array.from({ length: 15 }, () => Array(15).fill(0));
        g.moves.forEach(([r, c], i) => {
            const color = i % 2 === 0 ? 1 : 2;
            if (i >= 3) {
                const opp = 3 - color;
                if (openFourPoints(board, opp) > 0) {
                    const info = ctx.classifyMove(board, r, c, color);
                    board[r][c] = color;
                    const ok = info.five || info.openFour > 0 || info.fourCount > 0 || openFourPoints(board, opp) === 0;
                    board[r][c] = 0;
                    const who = color === jooColor ? 'joo' : 'opp';
                    tally[who][0]++;
                    if (ok) tally[who][1]++;
                }
            }
            board[r][c] = color;
        });
    }
}
for (const who of ['joo', 'opp']) {
    const [faced, ok] = tally[who];
    const miss = faced - ok;
    console.log(`${who}: faced ${faced}, ignored ${miss} (${faced ? (100 * miss / faced).toFixed(1) : 0}%)`);
}
