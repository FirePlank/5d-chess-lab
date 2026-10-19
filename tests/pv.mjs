import assert from 'node:assert/strict';

globalThis.self = globalThis;
globalThis.document = { addEventListener() {} };
globalThis.addEventListener = () => {};
const { Analysis } = await import('../static/js/analysis.js');
const analysis = Object.create(Analysis.prototype);
Object.assign(analysis, {
  cache: new Map(), searching: { id: 1, node: 0, multiPv: 3 },
  scheduleRender() {}, renderEngine() {}, renderMovesSoon() {},
});
const info = (depth, rank, move, id = 1) => analysis.onEngine({
  type: 'info', id,
  line: `info depth ${depth} multipv ${rank} score cp 20 pv ${move} submit`,
});
const lines = () => analysis.cache.get(0)?.lines.map((line) => line.pv);
for (const [rank, move] of ['e2e4', 'd2d4', 'g1f3'].entries()) info(4, rank + 1, `(0T1)${move}`);
const previous = lines();
info(5, 1, '(0T1)d2d4');
assert.deepEqual(lines(), previous, 'new best line does not replace the previous complete set');
info(5, 2, '(0T1)e2e4');
assert.deepEqual(lines(), previous, 'rank swaps do not hide or duplicate rows mid-update');
info(5, 3, '(0T1)b1c3');
assert.equal(analysis.cache.get(0).depth, 5);
assert.equal(lines().length, 3);
assert.notDeepEqual(lines(), previous);
const complete = lines();
info(6, 1, '(0T1)e2e4', 999);
assert.deepEqual(lines(), complete, 'stale search messages are ignored');
info(3, 1, '(0T1)e2e4'); info(3, 2, '(0T1)d2d4'); info(3, 3, '(0T1)g1f3');
assert.equal(analysis.cache.get(0).depth, 5, 'shallower results do not overwrite deeper cached analysis');
info(6, 1, '(0T1)e2e4'); info(6, 2, '(0T1)d2d4');
analysis.onEngine({ type: 'done', id: 1 });
assert.equal(analysis.cache.get(0).depth, 6);
assert.equal(lines().length, 2, 'a shorter final set is published when search ends');
analysis.searching = { id: 2, node: 1, multiPv: 1 };
info(1, 1, '(0T1)e2e4', 2);
assert.equal(analysis.cache.get(1).depth, 1, 'single-PV analysis updates immediately');
console.log('MultiPV updates remain complete between depths; final, stale and single-line cases passed.');
