#!/usr/bin/env node
// Search speed benchmark: board evaluations per second and completed depth.
// usage: node tools/match/bench.js [ai.js path] [timeLimitMs] [--plain]
//
// Positions: tools/match/bench_positions.json (move lists; prefixes of
// 8/14/20 moves from baseline games). The side to move becomes the AI (2).
// "evals" = board evaluations requested by the search: calls of
// fullEvaluateBoard for engines without getSearchStats (the original engine
// evaluated every node), leaf evaluations (cache hits included) otherwise.
// By default ai.js is loaded in a vm context like the tests and the match
// harness; --plain loads it in an ordinary function scope, which is closer to
// how a browser runs a global script.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const args = process.argv.slice(2);
const plain = args.includes('--plain');
const pos = args.filter(a => !a.startsWith('--'));
const aiPath = pos[0] || path.join(__dirname, '..', '..', 'ai.js');
const timeLimit = Number(pos[1] || 2200);
const src = fs.readFileSync(aiPath, 'utf8');
const noop = () => {};
const fetchStub = async () => ({ ok: false });

let api;
let evals = 0, maxDepth = 0;
if (plain) {
    // Evaluation counting by wrapping is impossible here, so getSearchStats is required.
    api = new Function('fetch', 'console', src +
        '\n;return { getAIMove, getSearchStats: typeof getSearchStats === "function" ? getSearchStats : null };')(
        fetchStub, { log: noop, warn: noop, error: noop });
} else {
    api = vm.createContext({ console: { log: noop, warn: noop, error: noop }, fetch: fetchStub });
    vm.runInContext(src, api);
    if (typeof api.getSearchStats !== 'function') {
        const origEval = api.fullEvaluateBoard;
        api.fullEvaluateBoard = function (b) { evals++; return origEval(b); };
        const origRoot = api.minimaxRoot;
        api.minimaxRoot = function (board, depth, ...rest) {
            const res = origRoot(board, depth, ...rest);
            if (!res.timeout && depth > maxDepth) maxDepth = depth;
            return res;
        };
    }
}
if (plain && !api.getSearchStats) {
    console.log(JSON.stringify({ ai: path.basename(aiPath), error: 'no getSearchStats; --plain unsupported' }));
    process.exit(0);
}

const lines = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench_positions.json'), 'utf8'));
let totEvals = 0, totMs = 0, depthSum = 0, worstMs = 0, totNodes = 0;
for (const moves of lines) {
    const toMove = moves.length % 2 === 0 ? 1 : 2; // black moves on even counts
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    moves.forEach(([r, c], i) => { b[r][c] = (i % 2 === 0 ? 1 : 2) === toMove ? 2 : 1; });
    evals = 0; maxDepth = 0;
    const t0 = process.hrtime.bigint();
    api.getAIMove(b, timeLimit);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (api.getSearchStats) {
        const st = api.getSearchStats();
        evals = st.leafEvals; maxDepth = st.depth; totNodes += st.nodes;
    }
    totEvals += evals; totMs += ms; depthSum += maxDepth; worstMs = Math.max(worstMs, ms);
}
const res = {
    ai: path.basename(aiPath), mode: plain ? 'plain' : 'vm', positions: lines.length, timeLimit,
    evalsPerSec: Math.round(totEvals / (totMs / 1000)),
    avgDepth: +(depthSum / lines.length).toFixed(2),
    avgMs: Math.round(totMs / lines.length), worstMs: Math.round(worstMs),
};
if (totNodes) res.nodesPerSec = Math.round(totNodes / (totMs / 1000));
console.log(JSON.stringify(res));
