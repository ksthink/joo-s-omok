// Tests for the Jev intuition layer (jev.js + getAIMoveAnalysis in ai.js).
// Run with: node --test tests/jev.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AI = 2, HUMAN = 1;

function load(fetchImpl) {
    const noop = () => {};
    const ctx = vm.createContext({
        console: { log: noop, warn: noop, error: noop, info: noop },
        fetch: fetchImpl || (async () => ({ ok: false, status: 500, json: async () => null })),
        AbortController, setTimeout, clearTimeout,
    });
    for (const f of ['ai.js', 'jev.js']) {
        const file = path.join(__dirname, '..', f);
        vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
    // top-level const bindings are not properties of the context object
    ctx.cfg = vm.runInContext('JEV_CONFIG', ctx);
    ctx.stats = vm.runInContext('jevStats', ctx);
    return ctx;
}

function makeBoard({ human = [], ai = [] }) {
    const b = Array.from({ length: 15 }, () => Array(15).fill(0));
    for (const [r, c] of human) b[r][c] = HUMAN;
    for (const [r, c] of ai) b[r][c] = AI;
    return b;
}

// A quiet early position (no threes on either side)
const QUIET = makeBoard({ human: [[7, 7], [6, 6]], ai: [[7, 6]] });
// Human open three on row 7: the engine must block, Jev must not be asked
const OPEN_THREE = makeBoard({ human: [[7, 6], [7, 7], [7, 8]], ai: [[6, 6], [5, 5]] });

const respond = (status, body) => ({ ok: status === 200, status, json: async () => body });

test('blend: alpha 0 keeps the engine best', () => {
    const ctx = load();
    const cands = [{ row: 1, col: 1, score: 100 }, { row: 2, col: 2, score: 90 }];
    const probs = [{ row: 1, col: 1, p: 0 }, { row: 2, col: 2, p: 1 }];
    const m = ctx.blendJevChoice(cands, probs, { alpha: 0, safetyMargin: 5000 });
    assert.deepStrictEqual({ ...m }, { row: 1, col: 1 });
});

test('blend: a confident Jev can pick a close alternative', () => {
    const ctx = load();
    const cands = [{ row: 1, col: 1, score: 100 }, { row: 2, col: 2, score: 90 }, { row: 3, col: 3, score: 0 }];
    const probs = [{ row: 1, col: 1, p: 0.05 }, { row: 2, col: 2, p: 0.95 }, { row: 3, col: 3, p: 0 }];
    const m = ctx.blendJevChoice(cands, probs, { alpha: 0.4, safetyMargin: 5000 });
    assert.deepStrictEqual({ ...m }, { row: 2, col: 2 });
});

test('blend: candidates beyond the safety margin are never chosen', () => {
    const ctx = load();
    const cands = [{ row: 1, col: 1, score: 10000 }, { row: 2, col: 2, score: 1000 }];
    const probs = [{ row: 1, col: 1, p: 0 }, { row: 2, col: 2, p: 1 }];
    const m = ctx.blendJevChoice(cands, probs, { alpha: 1, safetyMargin: 5000 });
    assert.deepStrictEqual({ ...m }, { row: 1, col: 1 });
});

test('analysis: forcing position is marked forced with no candidates', () => {
    const ctx = load();
    const a = ctx.getAIMoveAnalysis(OPEN_THREE.map(r => r.slice()), 500);
    assert.strictEqual(a.forced, true);
    assert.strictEqual(a.candidates.length, 0);
    assert.ok([[7, 5], [7, 9], [7, 4], [7, 10]].some(([r, c]) => a.move.row === r && a.move.col === c),
        `expected a block, got ${JSON.stringify(a.move)}`);
});

test('analysis: quiet position returns comparable candidates, best first, board untouched', () => {
    const ctx = load();
    const board = QUIET.map(r => r.slice());
    const a = ctx.getAIMoveAnalysis(board, 500);
    assert.deepStrictEqual(board, QUIET);
    assert.strictEqual(a.forced, false);
    assert.ok(a.candidates.length >= 2 && a.candidates.length <= 8);
    assert.deepStrictEqual({ row: a.candidates[0].row, col: a.candidates[0].col }, { ...a.move });
    for (const c of a.candidates) {
        assert.strictEqual(QUIET[c.row][c.col], 0);
        assert.strictEqual(typeof c.score, 'number');
    }
});

test('chooseAIMove: forcing position never calls the API', async () => {
    let calls = 0;
    const ctx = load(async () => { calls++; return respond(200, {}); });
    const m = await ctx.chooseAIMove(OPEN_THREE.map(r => r.slice()), 500, 'practice', null);
    assert.strictEqual(calls, 0);
    assert.ok(m);
});

test('chooseAIMove: challenge mode stays pure MiniMax', async () => {
    let calls = 0;
    const ctx = load(async () => { calls++; return respond(200, {}); });
    await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'challenge', null);
    assert.strictEqual(calls, 0);
});

test('chooseAIMove: follows a confident Jev answer within the safe set', async () => {
    let sent = null;
    const ctx = load(async (url, init) => {
        sent = JSON.parse(init.body);
        const cands = sent.candidates;
        const target = cands[cands.length - 1];
        return respond(200, {
            ok: true,
            probabilities: cands.map(c => ({ row: c.row, col: c.col, p: c === target ? 1 : 0 })),
        });
    });
    ctx.cfg.safetyMargin = Infinity; // let Jev win for this test
    ctx.cfg.alpha = 0.9;
    const m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', { row: 6, col: 6 });
    const target = sent.candidates[sent.candidates.length - 1];
    assert.deepStrictEqual({ ...m }, { row: target.row, col: target.col });
    assert.deepStrictEqual(sent.lastMove, { row: 6, col: 6 });
    assert.strictEqual(ctx.stats.overrides, 1);
});

test('chooseAIMove: missing key falls back and stops asking', async () => {
    let calls = 0;
    const ctx = load(async () => { calls++; return respond(503, { ok: false, error: 'jev_disabled' }); });
    const engine = ctx.getAIMove(QUIET.map(r => r.slice()), 300);
    const m1 = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.ok(m1);
    await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.strictEqual(calls, 1);
    assert.strictEqual(ctx.stats.fallbacks, 1);
    assert.ok(engine);
});

test('chooseAIMove: network error falls back to the engine move', async () => {
    const ctx = load(async () => { throw new Error('offline'); });
    const m = await ctx.chooseAIMove(QUIET.map(r => r.slice()), 300, 'practice', null);
    assert.ok(m && QUIET[m.row][m.col] === 0);
    assert.strictEqual(ctx.stats.fallbacks, 1);
});
