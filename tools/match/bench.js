#!/usr/bin/env node
// Search speed benchmark: evaluations per second and completed depth.
// usage: node tools/match/bench.js [ai.js path] [timeLimitMs] [games.jsonl]
// Positions are prefixes (8, 14, 20 moves) of the first games in the JSONL
// file; the side to move becomes the AI (2). "Evaluations" counts calls of the
// board evaluator (fullEvaluateBoard), wherever the engine calls it.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const aiPath = process.argv[2] || path.join(__dirname, '..', '..', 'ai.js');
const timeLimit = Number(process.argv[3] || 2200);
const gamesFile = process.argv[4] || path.join(__dirname, 'results', 'base_20_2200.jsonl');

const noop = () => {};
const ctx = vm.createContext({ console: { log: noop, warn: noop, error: noop }, fetch: async () => ({ ok: false }) });
vm.runInContext(fs.readFileSync(aiPath, 'utf8'), ctx);

let evals = 0, maxDepth = 0;
const origEval = ctx.fullEvaluateBoard;
ctx.fullEvaluateBoard = function (b) { evals++; return origEval(b); };
const origRoot = ctx.minimaxRoot;
ctx.minimaxRoot = function (board, depth, ...rest) {
    const res = origRoot(board, depth, ...rest);
    if (!res.timeout && depth > maxDepth) maxDepth = depth;
    return res;
};

const games = fs.readFileSync(gamesFile, 'utf8').trim().split('\n').map(JSON.parse);
const positions = [];
for (const g of games.slice(0, 8)) {
    for (const n of [8, 14, 20]) {
        if (g.moves.length <= n) continue;
        const toMove = n % 2 === 0 ? 1 : 2; // black moves on even counts
        const b = Array.from({ length: 15 }, () => Array(15).fill(0));
        g.moves.slice(0, n).forEach(([r, c], i) => {
            const color = i % 2 === 0 ? 1 : 2;
            b[r][c] = color === toMove ? 2 : 1;
        });
        positions.push(b);
    }
}

let totEvals = 0, totMs = 0, depthSum = 0, worstMs = 0;
for (const b of positions) {
    evals = 0; maxDepth = 0;
    const t0 = process.hrtime.bigint();
    ctx.getAIMove(b.map(r => r.slice()), timeLimit);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    totEvals += evals; totMs += ms; depthSum += maxDepth; worstMs = Math.max(worstMs, ms);
}
console.log(JSON.stringify({
    ai: path.basename(aiPath), positions: positions.length, timeLimit,
    evalsPerSec: Math.round(totEvals / (totMs / 1000)),
    avgDepth: +(depthSum / positions.length).toFixed(2),
    avgMs: Math.round(totMs / positions.length), worstMs: Math.round(worstMs),
}));
