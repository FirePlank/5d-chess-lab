import assert from 'node:assert/strict';
import { loadCore } from './core.mjs';
import { openingAt } from '../static/js/opening.js';
import { recordLine } from '../static/js/history.js';
import { OpeningTree, openingUrl, bookVariants } from '../static/js/opening-tree.js';
import { positionFromView } from '../static/js/position.js';

const core = await loadCore();
core.call({ cmd: 'new', position: 'Standard - Turn Zero' });
const play = (node, lan) => {
  const result = core.call({ cmd: 'play', node, lan });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.node;
};
const n1 = play(0, '(0T1)g1f3');
const n2 = play(n1, '(0T1)g8f6');
const digolian = play(n2, '(0T2)b1a3');
assert.equal(openingAt(core, digolian)?.name, 'Digolian Attack');
const outsideBook = play(digolian, '(0T2)h7h5');
assert.equal(openingAt(core, outsideBook)?.name, 'Digolian Attack');
assert.equal(openingAt(core, outsideBook)?.node, digolian);
assert.equal(openingAt(core, 0), null, 'rewinding before a named opening clears its label');
const unknown = play(n2, '(0T2)h2h3');
assert.equal(openingAt(core, unknown), null, 'sibling variations do not inherit another branch name');
const sarp = play(play(n2, '(0T2)d2d4'), '(0T2)c7c5');
assert.equal(openingAt(core, sarp)?.name, "Sarp's Counterattack");
assert.equal(openingAt(core, digolian)?.name, 'Digolian Attack', 'switching branches restores the right name');
core.call({ cmd: 'set_option', name: 'OwnBook', value: 0 });
assert.equal(openingAt(core, sarp)?.name, "Sarp's Counterattack", 'classification works with book play disabled');
core.call({ cmd: 'new', position: 'Standard - Turn Zero' });
assert.equal(openingAt(core, 0), null, 'a new game has no stale name');
assert.equal(openingAt({ call() { throw new Error('No opening data'); } }, 0), null);
const exported = JSON.parse(recordLine({ moves: [], opening: 'Digolian Attack' }));
assert.equal(exported.opening, 'Digolian Attack', 'saved opening names survive JSONL export');
console.log('Opening names persist beyond theory, follow variations and rewinds, and survive saved-game export.');

const explorer = new OpeningTree(await loadCore());
const supported = bookVariants(core, core.call({ cmd: 'variants' }).variants);
assert.deepEqual(supported.map(v => v.name), ['Standard', 'Standard - Turn Zero', 'Standard - Defended Pawn']);
assert.equal(core.call({ cmd: 'tree' }).tree.nodes.length, 1, 'filtering variants leaves the selected game intact');
const variant = 'Standard - Turn Zero';
explorer.load(variant);
assert.equal(explorer.children.length, 8, 'all first moves, including non-play recommendations, are browsable');
const line = ['(0T1)g1f3', '(0T1)g8f6', '(0T2)d2d4', '(0T2)c7c5'];
explorer.load(variant, line);
assert.equal(explorer.opening.name, "Sarp's Counterattack");
assert.equal(explorer.path.length, 5);
const params = new URLSearchParams(openingUrl(variant, line).split('?')[1]);
explorer.load(params.get('variant'), JSON.parse(params.get('moves')));
assert.equal(explorer.opening.name, "Sarp's Counterattack", 'direct URLs replay the same opening');
const imported = await loadCore();
assert.equal(imported.call({ cmd: 'new', position: positionFromView(explorer.view) }).ok, true);
let depth = line.length;
while (explorer.children.length && depth < 40) {
  line.push(explorer.children[0].lan);
  explorer.load(variant, line);
  depth++;
}
assert.equal(explorer.children.length, 0, 'nested exploration reaches the actual book boundary');
assert.ok(depth > 4, 'exploration continues beyond the first named position');
explorer.load(variant, ['(0T1)g1f3', '(0T1)g8f6', '(0T2)e2e3', '(0T2)c7c6',
  '(0T3)f1c4', '(0T3)d8b6', '(0T4)c4f7', '(0T4)e8f7', '(0T5)f3(0T4)f5']);
assert.ok(explorer.view.timelines.length > 1, 'deep time-travel lines retain their additional timelines');
assert.equal(imported.call({ cmd: 'new', position: positionFromView(explorer.view) }).ok, true,
  'branched positions can be passed intact to Play');
assert.throws(() => explorer.load(variant, ['(0T1)h2h3']), /not in the opening book/);
explorer.load(variant);
assert.equal(explorer.path.length, 1, 'returning to the root clears the previous line');
assert.equal(core.call({ cmd: 'book', node: 0 }).opening, null, 'browsing uses an independent rules instance');
console.log(`Opening explorer: all root moves, direct URLs, ${depth}-action nested line, multiple timelines and book boundary verified.`);
