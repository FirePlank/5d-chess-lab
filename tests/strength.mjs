import assert from 'node:assert/strict';
import { loadCore } from './core.mjs';

const info = [];
const core = await loadCore({ onInfo: (line) => info.push(line) });
core.call({ cmd: 'set_hash', mb: 4 });
const initial = core.call({ cmd: 'new', position: 'Standard - Turn Zero' });
assert.equal(initial.ok, true);
const position = core.call({ cmd: 'view', node: 0, draft: [] }).view.position;
for (let skillLevel = 1; skillLevel <= 8; skillLevel++) {
  info.length = 0;
  const result = core.call({ cmd: 'search', position, skillLevel, depth: 1, movetime: 100, newGame: true });
  assert.equal(result.ok, true);
  assert.ok(result.bestmove, `level ${skillLevel} returns an action`);
  core.call({ cmd: 'new', position });
  assert.equal(core.call({ cmd: 'play', node: 0, lan: result.bestmove }).ok, true, `level ${skillLevel} is legal`);
  info.length = 0;
  assert.ok(core.call({ cmd: 'search', position, skillLevel, book: true, movetime: 100 }).bestmove);
  assert.ok(info.some((line) => line.startsWith('string book ')), `level ${skillLevel} honors opening book`);
}
// A play handicap must not stick to a later analysis request.
core.call({ cmd: 'search', position, skillLevel: 1, depth: 1, movetime: 100 });
info.length = 0;
assert.equal(core.call({ cmd: 'search', position, depth: 2, movetime: 1000 }).ok, true);
assert.ok(info.some((line) => /depth 2\b/.test(line)));
assert.ok(info.every((line) => !line.includes('multipv')));
console.log('All eight WASM levels return legal actions; analysis resets to full strength.');
