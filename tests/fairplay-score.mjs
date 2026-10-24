// Fair play's scoring (static/js/fairplay-score.js): judging actions against the detector's lines,
// the page's signals joined to the evidence and the rules they open cases by, and the bet: an
// engine's actions raise a player's score, a person's don't. node tests/fairplay-score.mjs
import assert from 'node:assert/strict';
import {
  GOOD_LOSS, AWAY_MS, AWAY, TIMING, CASE_LOG_SCORE, judge, gather, withSignals, awayStats, timingStats, signalFindings,
  gameLogRatios, bestRunLogScore, moveScore,
} from '../static/js/fairplay-score.js';

const line = (action, win) => ({ action, wdl: [Math.round(win * 1000), 0, 1000 - Math.round(win * 1000)] });
// A position with one clearly best action, a second good one and three bad ones.
const pos = {
  lines: [line('a1 b1', 0.6), line('c1', 0.6 - GOOD_LOSS / 2), line('d1', 0.4), line('e1', 0.35), line('f1', 0.3)],
  topByDepth: ['c1', 'c1', 'c1', 'a1 b1', 'a1 b1', 'a1 b1', 'a1 b1', 'a1 b1'], inCheck: false, forced: false,
};
pos.lines[0].captures = true;
assert.equal(judge(pos, null, 'b1 a1').outcome, 'top', 'the moves of an action in any order');
assert.equal(judge(pos, null, 'c1').outcome, 'good');
assert.equal(judge(pos, null, 'd1').outcome, 'miss');
const d = judge(pos, null, 'a1 b1').difficulty;
assert.equal(d.goodMoves, 2);
assert.equal(d.shallowFinds, true, 'depth 3 already found a good action');
assert.equal(d.bestCaptures, true);
// Outside the lines: valued by the position after it, and no better than the last line.
assert.equal(judge(pos, { lines: [line('x', 0.45)] }, 'z9').outcome, 'miss', 'worse than the five lines, however it looks after');
const wide = { ...pos, lines: [line('a1 b1', 0.6), line('c1', 0.6), line('d1', 0.6), line('e1', 0.6), line('f1', 0.59)] };
assert.equal(judge(wide, { lines: [line('x', 0.41)] }, 'z9').outcome, 'good', '0.59 after it');
assert.equal(judge(wide, { lines: [line('x', 0.9)] }, 'z9').outcome, 'miss');
assert.equal(judge(pos, null, 'z9'), undefined, 'outside the lines with no look after it: nothing');
// Decided and forced positions say nothing.
assert.equal(judge({ ...pos, lines: [line('a1', 0.99), line('c1', 0.98)] }, null, 'a1'), undefined);
assert.equal(judge({ ...pos, forced: true }, null, 'a1 b1'), undefined);
assert.deepEqual(gather([pos, pos, pos], ['a1 b1', 'c1'], 1).map((e) => e.ply), [1], 'one side\'s actions');

// The page's signals, joined to the evidence.
const ev = (outcome, ply) => ({ ply, outcome, loss: 0, difficulty: d });
const joined = withSignals([ev('top', 0), ev('miss', 2), ev('good', 4)],
  { 0: { turn_ms: 9000, hidden_ms: 6000, blurred_ms: 6500 }, 2: { turn_ms: 4000 }, 4: { unmeasured: true } });
assert.deepEqual(joined.map((e) => [e.away_ms, e.turn_ms]), [[6500, 9000], [0, 4000], [null, null]]);

// Engine matches on turns away from the page, against the player's own other turns.
const turns = (n, outcome, away) => Array.from({ length: n }, () => ({ outcome, away_ms: away ? AWAY_MS + 1000 : 0, turn_ms: 1000 + Math.random() * 20000 }));
const cheatAway = [...turns(14, 'top', true), ...turns(2, 'miss', true), ...turns(10, 'top', false), ...turns(30, 'miss', false), ...turns(10, 'good', false)];
const a = awayStats(cheatAway);
assert.equal(a.away, 16);
assert.ok(a.topAway - a.topPresent >= AWAY.minGap && a.z >= AWAY.minZ, JSON.stringify(a));
assert.deepEqual(signalFindings(cheatAway).map((f) => f.reason), ['away']);
// Someone who looks away often but plays as well either way: no case.
const honestAway = [...turns(6, 'top', true), ...turns(10, 'miss', true), ...turns(15, 'top', false), ...turns(25, 'miss', false)];
assert.deepEqual(signalFindings(honestAway), []);
// Too few away turns: no case, however good.
assert.deepEqual(signalFindings([...turns(AWAY.minAway - 1, 'top', true), ...turns(40, 'miss', false)]), []);

// Think times as even as a program's.
const even = Array.from({ length: TIMING.minActions }, () => ({ outcome: 'good', away_ms: 0, turn_ms: 5000 + Math.random() * 400 }));
assert.ok(timingStats(even).cv < TIMING.maxCv);
assert.deepEqual(signalFindings(even).map((f) => f.reason), ['timing']);
const human = Array.from({ length: 60 }, (_, i) => ({ outcome: 'good', away_ms: 0, turn_ms: 1500 + (i % 7) * 4000 }));
assert.deepEqual(signalFindings(human), [], 'uneven times');
assert.deepEqual(signalFindings(even.slice(0, TIMING.minActions - 1)), [], 'too few');

// The bet: hard positions where an engine finds the only good action and a person mostly doesn't.
const hard = { goodMoves: 1, shallowFinds: false, deepFind: true, bestCaptures: false, inCheck: false };
const easy = { goodMoves: 4, shallowFinds: true, deepFind: false, bestCaptures: true, inCheck: false };
assert.ok(moveScore({ outcome: 'top', difficulty: hard }, 1500, 60) > 0, 'finding a hard only move is evidence');
assert.ok(moveScore({ outcome: 'miss', difficulty: hard }, 1500, 60) < 0, 'missing it clears a little');
assert.ok(Math.abs(moveScore({ outcome: 'good', difficulty: easy }, 1500, 60)) < 0.5, 'an easy good action says little');
const engineGame = Array.from({ length: 20 }, (_, i) => ({ outcome: i % 5 ? 'top' : 'good', difficulty: i % 2 ? hard : easy }));
const personGame = Array.from({ length: 20 }, (_, i) => ({ outcome: i % 3 ? 'miss' : 'good', difficulty: i % 2 ? hard : easy }));
const g = (e) => gameLogRatios(e, 1500, 60);
assert.ok(Math.max(...g(engineGame)) > 0 && Math.max(...g(personGame)) <= 0.01);
assert.equal(bestRunLogScore([g(personGame), g(personGame), g(personGame)]), 0, 'a person\'s games: no score');
let n = 0;
for (const games = []; n < 60 && bestRunLogScore(games) < CASE_LOG_SCORE; n++) games.push(g(engineGame));
assert.ok(n < 60, `an engine's games cross the case line (after ${n})`);
console.log(`fairplay-score: judging, signals and their rules, and the bet passed (engine games to the line: ${n})`);
