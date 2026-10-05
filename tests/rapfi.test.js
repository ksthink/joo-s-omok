// Tests for the Rapfi engine integration (rapfi-worker.js protocol code, the real
// WebAssembly engine in rapfi/, and the Rapfi path of chooseAIMove in jev.js).
// Run with: node --test tests/rapfi.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { createRapfiParser, rapfiThinkCommands, RAPFI_SETUP_COMMANDS } = require('../rapfi-worker.js');

const AI = 2, HUMAN = 1;

function makeBoard({ human = [], ai = [] }) {
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    for (const [r, c] of human) b[r][c] = HUMAN;
    for (const [r, c] of ai) b[r][c] = AI;
    return b;
}

function stonesOf(board) {
    const stones = [];
    board.forEach((row, r) => row.forEach((v, c) => { if (v) stones.push({ row: r, col: c, own: v === AI }); }));
    return stones;
}

// ─── Real engine, driven the way the worker drives it ──────────────────────────
let enginePromise = null;
function startEngine() {
    if (enginePromise) return enginePromise;
    const dir = path.join(ROOT, 'rapfi');
    // The emscripten loader expects CommonJS globals when it runs under Node
    globalThis.require = require;
    globalThis.__dirname = dir;
    const Rapfi = vm.runInThisContext(fs.readFileSync(path.join(dir, 'rapfi-single.js'), 'utf8') + '\nRapfi');
    const state = { parser: null, done: null };
    enginePromise = Rapfi({
        locateFile: u => path.join(dir, /^rapfi.*\.data$/.test(u) ? 'rapfi.data' : u),
        onReceiveStdout: line => {
            if (!state.parser) return;
            const move = state.parser.feed(line);
            if (move) { const done = state.done; const parser = state.parser; state.parser = state.done = null; done(parser.result(move)); }
        },
        onReceiveStderr: () => {}, onExit: () => {}, setStatus: () => {},
    }).then(instance => {
        for (const cmd of RAPFI_SETUP_COMMANDS) instance.sendCommand(cmd);
        return (board, timeMs, nbest) => new Promise(resolve => {
            state.parser = createRapfiParser();
            state.done = resolve;
            for (const cmd of rapfiThinkCommands(stonesOf(board), timeMs, nbest)) instance.sendCommand(cmd);
        });
    });
    return enginePromise;
}

const QUIET = makeBoard({ human: [[7, 7], [6, 6]], ai: [[7, 6]] });
// AI has an open three on row 7 and the move: G8/K8 makes an open four
const AI_WINS = makeBoard({ human: [[3, 3], [3, 5], [11, 11], [12, 2]], ai: [[7, 7], [7, 8], [7, 9]] });
// Human has four in a row with one open end: the only move is the block at (7, 10)
const MUST_BLOCK = makeBoard({ human: [[7, 6], [7, 7], [7, 8], [7, 9]], ai: [[7, 5], [6, 6], [8, 8]] });

test('engine: quiet position gives several ranked candidates', async () => {
    const think = await startEngine();
    const res = await think(QUIET, 400, 6);
    assert.strictEqual(QUIET[res.move.row][res.move.col], 0, 'move is on an empty cell');
    assert.ok(res.candidates.length >= 2, `candidates: ${res.candidates.length}`);
    assert.deepStrictEqual({ row: res.candidates[0].row, col: res.candidates[0].col }, res.move, 'played move comes first');
    for (const c of res.candidates) {
        assert.strictEqual(QUIET[c.row][c.col], 0);
        assert.ok(c.winrate >= 0 && c.winrate <= 1, `winrate ${c.winrate}`);
    }
    assert.ok(res.depth >= 4, `depth ${res.depth}`);
});

test('engine: blocks a four', async () => {
    const think = await startEngine();
    const res = await think(MUST_BLOCK, 300, 6);
    assert.deepStrictEqual(res.move, { row: 7, col: 10 });
});

test('engine: reports a forced win as mate', async () => {
    const think = await startEngine();
    const res = await think(AI_WINS, 300, 6);
    assert.ok(res.candidates[0].mate > 0, `mate: ${res.candidates[0].mate}, eval: ${res.candidates[0].eval}`);
    assert.strictEqual(res.candidates[0].winrate, 1);
    assert.ok([6, 10].includes(res.move.col) && res.move.row === 7, `move ${JSON.stringify(res.move)}`);
});

// ─── Protocol helpers ──────────────────────────────────────────────────────────
test('parser: keeps the latest report per PV and converts x,y to row/col', () => {
    const p = createRapfiParser();
    const lines = [
        'MESSAGE OptiTime 502ms | MaxTime 670ms',
        'INFO PV 0', 'INFO DEPTH 3', 'INFO EVAL 10', 'INFO WINRATE 0.51', 'INFO BESTLINE 8,7 9,9', 'INFO PV DONE',
        'INFO PV 1', 'INFO DEPTH 3', 'INFO EVAL -40', 'INFO WINRATE 0.45', 'INFO BESTLINE 5,6 6,6', 'INFO PV DONE',
        'INFO PV 0', 'INFO DEPTH 4', 'INFO EVAL -80', 'INFO WINRATE 0.40', 'INFO BESTLINE 8,7 9,9 3,3', 'INFO PV DONE',
        'INFO PV 2', 'INFO DEPTH 4', 'INFO EVAL -M6', 'INFO WINRATE 0.0', 'INFO BESTLINE 1,2', 'INFO PV DONE',
    ];
    for (const l of lines) assert.strictEqual(p.feed(l), null);
    const move = p.feed('5,6');
    assert.deepStrictEqual(move, { row: 6, col: 5 });
    const res = p.result(move);
    assert.deepStrictEqual(res.candidates.map(c => [c.row, c.col, c.winrate, c.mate]),
        [[6, 5, 0.45, null], [7, 8, 0.40, null], [2, 1, 0, -6]]);
    assert.strictEqual(res.depth, 4);
});

test('commands: own stones are side 1, coordinates are x,y', () => {
    const cmds = rapfiThinkCommands([{ row: 7, col: 3, own: true }, { row: 2, col: 9, own: false }], 700.4, 6);
    assert.deepStrictEqual(cmds, ['INFO TIMEOUT_TURN 700', 'YXBOARD 3,7,1 9,2,2 DONE', 'YXNBEST 6']);
});

// ─── chooseAIMove with Rapfi candidates ────────────────────────────────────────
function load({ fetchImpl, think, ready = true }) {
    const noop = () => {};
    const ctx = vm.createContext({
        console: { log: noop, warn: noop, error: noop, info: noop },
        fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => null })),
        AbortController, setTimeout, clearTimeout,
        // stand-ins for rapfi.js
        RAPFI_CONFIG: { timeMs: 300, candidates: 6 },
        rapfiActive: mode => mode === 'practice',
        rapfiReady: () => ready,
        rapfiThink: think,
    });
    for (const f of ['ai.js', 'jev.js']) {
        const file = path.join(ROOT, f);
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    ctx.stats = vm.runInContext('jevStats', ctx);
    return ctx;
}

const CANDS = [
    { row: 8, col: 8, winrate: 0.52, eval: 20, mate: null },
    { row: 6, col: 7, winrate: 0.49, eval: -5, mate: null },
    { row: 5, col: 5, winrate: 0.30, eval: -200, mate: null },   // outside the 10-point margin
];
const jevAnswer = (pick, seen) => async (url, init) => {
    const body = JSON.parse(init.body);
    if (seen) seen.push(body);
    return { ok: true, status: 200, json: async () => ({
        ok: true, confidence: 0.9,
        probabilities: body.candidates.map(c => ({ row: c.row, col: c.col, p: c.row === pick.row && c.col === pick.col ? 1 : 0 })),
    }) };
};

test('chooseAIMove: Jev picks among Rapfi candidates within the safety margin', async () => {
    const seen = [];
    const ctx = load({ fetchImpl: jevAnswer(CANDS[1], seen), think: async () => ({ move: { row: 8, col: 8 }, candidates: CANDS, depth: 9 }) });
    const m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.deepStrictEqual({ row: m.row, col: m.col }, { row: 6, col: 7 });
    assert.strictEqual(ctx.stats.overrides, 1);
    assert.deepStrictEqual(seen[0].candidates.map(c => c.winrate), [0.52, 0.49, 0.30], 'win rates are sent to Jev');
});

test('chooseAIMove: Jev cannot pick a Rapfi candidate outside the margin', async () => {
    const ctx = load({ fetchImpl: jevAnswer(CANDS[2]), think: async () => ({ move: { row: 8, col: 8 }, candidates: CANDS, depth: 9 }) });
    const m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.deepStrictEqual({ row: m.row, col: m.col }, { row: 8, col: 8 });
});

test('chooseAIMove: a proven win or a lone safe candidate skips Jev', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: false, status: 500, json: async () => null }; };
    const mate = [{ row: 8, col: 8, winrate: 1, eval: null, mate: 5 }, { row: 6, col: 7, winrate: 0.95, eval: 900, mate: null }];
    let ctx = load({ fetchImpl, think: async () => ({ move: { row: 8, col: 8 }, candidates: mate, depth: 9 }) });
    assert.deepStrictEqual(await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null), { row: 8, col: 8 });
    const lone = [CANDS[0], CANDS[2]];
    ctx = load({ fetchImpl, think: async () => ({ move: { row: 8, col: 8 }, candidates: lone, depth: 9 }) });
    assert.deepStrictEqual(await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null), { row: 8, col: 8 });
    assert.strictEqual(calls, 0);
});

test('chooseAIMove: built-in engine plays when Rapfi fails or is not loaded', async () => {
    let ctx = load({ think: async () => { throw new Error('engine timeout'); } });
    let m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.strictEqual(QUIET[m.row][m.col], 0);
    let asked = false;
    ctx = load({ ready: false, think: async () => { asked = true; return null; } });
    m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.strictEqual(QUIET[m.row][m.col], 0);
    assert.strictEqual(asked, false);
});

test('chooseAIMove: challenge mode never uses Rapfi', async () => {
    let asked = false;
    const ctx = load({ think: async () => { asked = true; return null; } });
    await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'challenge', null);
    assert.strictEqual(asked, false);
});
