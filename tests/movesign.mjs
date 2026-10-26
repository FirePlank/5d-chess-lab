// Broadcast actions' signatures (static/js/movesign.js): a page's key signs its actions, and no
// other key, game, ply or action passes. Run: node tests/movesign.mjs
import assert from 'node:assert/strict';
import { newKey, sign, verify } from '../static/js/movesign.js';

const a = await newKey(), b = await newKey();
assert.match(a.pub, /^[A-Za-z0-9_-]{80,100}$/, 'a public key fits game_key');
const sig = await sign(a, 'g1', 4, '(0T3)e2e4');
assert.equal(await verify(a.pub, sig, 'g1', 4, '(0T3)e2e4'), true, 'its own action');
assert.equal(await verify(b.pub, sig, 'g1', 4, '(0T3)e2e4'), false, 'another key');
assert.equal(await verify(a.pub, sig, 'g2', 4, '(0T3)e2e4'), false, 'another game');
assert.equal(await verify(a.pub, sig, 'g1', 5, '(0T3)e2e4'), false, 'another ply');
assert.equal(await verify(a.pub, sig, 'g1', 4, '(0T3)e2e3'), false, 'another action');
assert.equal(await verify(a.pub, 'not-a-signature', 'g1', 4, '(0T3)e2e4'), false, 'garbage');
assert.equal(await verify('not-a-key', sig, 'g1', 4, '(0T3)e2e4'), false, 'a bad key');
console.log('movesign: signed actions pass, every other one fails');
