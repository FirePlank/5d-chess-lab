import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sounds, Sounds, moveSound, givesCheck } from '../static/js/sound.js';
import { loadCore } from './core.mjs';

assert.equal(moveSound('(0T1)e4'), 'move');
assert.equal(moveSound('(0T1)O-O'), 'castle');
assert.equal(moveSound('(0T1)O-O-O'), 'castle');
assert.equal(moveSound('(0T1)exd6'), 'capture');
assert.equal(moveSound('(0T1)B>>x(1T2)f7'), 'capture');
assert.equal(givesCheck('(+0T1)Nf3'), false);
assert.equal(givesCheck('(+0T1)Qh5+'), true);
assert.equal(givesCheck('(0T1)Bxc7#'), true);

const audio = new Sounds(), events = [];
audio.play = (...args) => events.push(args);
audio.action('(0T1)O-O');
assert.deepEqual(events.map((e) => e[0]), ['move', 'move']);
assert.equal(events[1][1].delay, 0.08);
events.length = 0;
audio.action('(0T1)Qxf7+', { move: false });
assert.deepEqual(events.map((e) => e[0]), ['check']);
events.length = 0;
audio.end('1-0', 'w'); audio.end('0-1', 'w'); audio.end('1/2-1/2', 'b');
assert.deepEqual(events.map((e) => e[0]), ['win', 'loss', 'draw']);

const pending = new Sounds();
let resolveBuffer, started = 0;
pending.context = { state: 'running', createBufferSource() { started++; } };
pending.load = () => new Promise((resolve) => { resolveBuffer = resolve; });
const loadingPlay = pending.play('move');
pending.enabled = false;
pending.generation++;
resolveBuffer({});
await loadingPlay;
assert.equal(started, 0, 'muting cancels playback waiting for an audio file');
globalThis.localStorage = { getItem: () => 'false' };
assert.equal(new Sounds().enabled, false, 'mute survives a reload');
delete globalThis.localStorage;

// Resolve actual engine notation, including castling and captures, through the sound mapper.
const core = await loadCore();
for (const [fen, lan, expected] of [
  ['4k3/8/8/8/8/8/8/4K*2R*', '(0T1)e1g1', 'castle'],
  ['4k3/8/8/8/8/4p3/4R3/4K3', '(0T1)e2e3', 'capture'],
]) {
  assert.equal(core.call({ cmd: 'new', position: `size 8x8 odd fen [${fen}:0:1:w]` }).ok, true);
  const result = core.call({ cmd: 'play', node: 0, lan });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(moveSound(result.tree.nodes[result.node].san), expected);
}

// MP3 aliases in Lila are text files; only real audio samples should be bundled.
for (const name of ['Move', 'Capture', 'GenericNotify']) {
  const bytes = readFileSync(new URL(`../static/sounds/${name}.mp3`, import.meta.url));
  assert.ok(bytes.length > 1000, `${name} is audio, not an alias`);
}

globalThis.self = globalThis;
const { Play } = await import('../static/js/play.js');
const emitted = [];
sounds.action = (san) => emitted.push(san);
sounds.end = () => emitted.push('end');
const play = new Play({ board: {}, input: { reset() {} } });
play.active = true;
play.show = () => {};
play.archive = () => {};
play.rules = { call(req) {
  if (req.cmd === 'new') return { tree: { nodes: [{ children: [] }] } };
  const id = play.tree.nodes.length;
  play.tree.nodes[req.node].children.push(id);
  play.tree.nodes.push({ children: [], san: req.lan, lan: req.lan });
  return { tree: play.tree, node: id };
} };
const game = (moves, over = null) => ({ start: 'test', moves, humanColor: 'w', over });
play.sync(game(['e4'])); // Initial history is silent.
assert.deepEqual(emitted, []);
play.sync(game(['e4', 'e5']));
play.sync(game(['e4', 'e5'])); // A server acknowledgement is silent.
assert.deepEqual(emitted, ['e5']);
play.active = false;
play.sync(game(['e4', 'e5', 'Nf3']));
assert.deepEqual(emitted, ['e5']);
play.active = true;
play.state = { game: game(['e4', 'e5', 'Nf3']) };
play.onState({ you: true, game: game(['e4', 'e5', 'Nf3'], { result: '1-0' }) });
play.onState({ you: true, game: game(['e4', 'e5', 'Nf3'], { result: '1-0' }) });
assert.deepEqual(emitted, ['e5', 'end']);

// Undo and clearing drafts are silent; only forward history navigation plays a cue.
const { MoveInput } = await import('../static/js/input.js');
const draft = { draft: ['e4', 'e5'], deselect() {}, refresh() {} };
sounds.play = (name) => emitted.push(name);
emitted.length = 0;
MoveInput.prototype.undo.call(draft);
MoveInput.prototype.clear.call(draft);
assert.deepEqual(emitted, []);

globalThis.document = { addEventListener() {} };
globalThis.addEventListener = () => {};
const { Analysis } = await import('../static/js/analysis.js');
const nodes = [
  { ply: 0, parent: null, children: [1] },
  { ply: 1, parent: 0, children: [2], san: 'e4' },
  { ply: 2, parent: 1, children: [3], san: 'e5' },
  { ply: 3, parent: 2, children: [], san: 'Nf3' },
];
for (const Controller of [Analysis, Play]) {
  const viewer = Object.create(Controller.prototype);
  Object.assign(viewer, { tree: { nodes }, cur: 3, input: { reset() {} }, show() {}, restartEngine() {} });
  emitted.length = 0;
  viewer.goto(1); // Jump back more than one action.
  viewer.goto(0);
  viewer.goto(0);
  assert.deepEqual(emitted, [], `${Controller.name}: backward and repeated navigation is silent`);
  viewer.goto(1);
  viewer.goto(3);
  assert.deepEqual(emitted, ['e4', 'Nf3'], `${Controller.name}: forward navigation plays the destination action`);
}
console.log('Sound classification, real castling/capture notation, result cues, and duplicate suppression passed.');
