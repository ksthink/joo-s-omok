#!/usr/bin/env node
// Resident wrapper around ai.js for the match harness.
// stdin : one JSON per line  {board, timeLimit, me?}
//         board uses 0 = empty, 1 = black, 2 = white. `me` is this engine's
//         colour (1|2). If `me` is omitted the board is assumed to already be
//         in engine form (2 = this engine, 1 = opponent).
// stdout: one JSON per line  {row, col, ms}
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const readline = require('readline');

const AI_PATH = process.env.JOO_AI_PATH || path.join(__dirname, '..', '..', 'ai.js');

function loadEngine(file) {
    const noop = () => {};
    const context = vm.createContext({
        console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
        fetch: async () => ({ ok: false, json: async () => null }),
        Math, Date, Array, Object, Map, Set, Uint8Array, Int8Array, Int32Array,
        Uint32Array, Float64Array, JSON, Number, String, Boolean, Infinity, NaN,
    });
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    return context;
}

const ctx = loadEngine(AI_PATH);

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
    line = line.trim();
    if (!line) return;
    let req;
    try { req = JSON.parse(line); } catch (e) {
        process.stdout.write(JSON.stringify({ error: 'bad json' }) + '\n');
        return;
    }
    const me = req.me;
    const board = req.board.map(row => row.map(v => {
        if (!me || v === 0) return v;
        return v === me ? 2 : 1;
    }));
    const t0 = process.hrtime.bigint();
    const move = ctx.getAIMove(board, req.timeLimit || 1000);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    process.stdout.write(JSON.stringify({ row: move.row, col: move.col, ms: Math.round(ms) }) + '\n');
});
