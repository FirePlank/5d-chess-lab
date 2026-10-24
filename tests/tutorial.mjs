// The tutorial's lessons (static/js/lessons.js) through the rules core: every position loads,
// marks and click targets name boards that exist (and voids ones that don't), every solution
// is legal, completes its action and meets its goal, every explained wrong move is legal, and
// the opponent's moves are legal. Needs the browser core (cargo wasm): node tests/tutorial.mjs
import assert from 'node:assert/strict';
import { LESSONS, parseMoves, parsePlace, marksOf, moveLan } from '../static/js/lessons.js';
import { loadCore } from './core.mjs';

const core = await loadCore();
const call = (req) => {
  const r = core.call(req);
  if (!r.ok) throw new Error(`${JSON.stringify(req)}: ${r.error}`);
  return r;
};
const view = (node, draft = []) => call({ cmd: 'view', node, draft }).view;
const hasBoard = (v, b) => v.boards.some(([l, t, c]) => l === b.l && t === b.t && c === b.c);

let steps = 0;
const ids = new Set();
for (const lesson of LESSONS) {
  assert.ok(!ids.has(lesson.id), `lesson id ${lesson.id} is unique`);
  ids.add(lesson.id);
  assert.ok(lesson.title && lesson.blurb && lesson.recap?.length && lesson.steps.length, `${lesson.id}: title, blurb, recap, steps`);
  let node = null;
  lesson.steps.forEach((step, i) => {
    const where = `${lesson.id} step ${i + 1}`;
    try {
      assert.ok(['read', 'choose', 'click', 'play'].includes(step.type), 'type');
      assert.ok(step.say && step.say.split(/\s+/).length <= 32, `say is short (${step.say.split(/\s+/).length} words)`);
      if (step.at) {
        call({ cmd: 'new', position: step.at[0] });
        node = step.at[1] ? call({ cmd: 'play_line', node: 0, line: step.at[1] }).node : 0;
      }
      assert.ok(node != null, 'a position (the first step needs `at`)');
      if (step.then) node = call({ cmd: 'play', node, moves: parseMoves(step.then) }).node;
      const v = view(node);
      assert.equal(v.status, 'playing', 'the game is on');
      assert.ok(step.inactive || v.timelines.every((tl) => tl.active), 'every timeline is active (an inactive one only where the lesson makes it)');
      assert.equal(v.checks.length > 0, !!step.check, step.check ? 'the side to move is in check' : 'no check (mark the step `check` if meant)');
      const marks = marksOf(step.mark, v.player);
      if (marks) {
        for (const b of [...marks.boards, ...marks.squares]) assert.ok(hasBoard(v, b), `marked board (${b.l}T${b.t}${'wb'[b.c]}) exists`);
        for (const b of marks.voids) assert.ok(!hasBoard(v, b), `void (${b.l}T${b.t}${'wb'[b.c]}) has no board`);
        for (const a of [...marks.arrows, ...marks.threats]) {
          for (const p of [a.from, a.to]) assert.ok(hasBoard(v, { l: p[0], t: p[1], c: a.c }), `arrow end (${p[0]}T${p[1]}) exists`);
        }
      }
      if (step.type === 'choose') {
        assert.ok(step.options.length >= 2 && step.options[step.answer] != null, 'options and answer');
      }
      if (step.type === 'click') {
        for (const t of step.targets) assert.ok(hasBoard(v, parsePlace(t, v.player)), `target ${t} exists`);
        for (const t of Object.keys(step.why || {})) assert.ok(hasBoard(v, parsePlace(t, v.player)), `why target ${t} exists`);
      }
      if (step.type === 'play') {
        assert.ok(step.solution, 'a solution');
        const moves = parseMoves(step.solution);
        assert.equal(moves.map(moveLan).join(' '), step.solution.trim().split(/\s+/).join(' '), 'solution notation round-trips');
        const draft = [];
        for (const m of moves) {
          call({ cmd: 'check_move', node, draft, move: m });
          draft.push(m);
        }
        const dv = view(node, draft);
        assert.ok(dv.canSubmit, `the solution completes the action (${dv.submitError})`);
        for (const lan of Object.keys(step.why || {})) {
          const [m] = parseMoves(lan);
          assert.equal(moveLan(m), lan, `why move ${lan} round-trips`);
          call({ cmd: 'check_move', node, draft: [], move: m });
        }
        const next = call({ cmd: 'play', node, moves }).node;
        if (step.goal) {
          const verdict = step.goal({ moves, before: v, after: view(next) });
          assert.equal(verdict, true, `the solution meets the goal (${verdict})`);
        }
        node = next;
        if (step.reply) node = call({ cmd: 'play', node, moves: parseMoves(step.reply) }).node;
      }
      steps++;
    } catch (e) {
      throw new Error(`${where}: ${e.message}`);
    }
  });
}
console.log(`tutorial: ok (${LESSONS.length} lessons, ${steps} steps)`);
