// The online-play database (supabase/migrations) in PGlite: seeks, challenges, games, clocks,
// disconnects, draws, rematches, chat and the sweep, with time moved by rewriting timestamps.
// Needs @electric-sql/pglite (npm i -D in tests/ or .tools/): node tests/online-sql.mjs
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const here = new URL('.', import.meta.url);
const require = createRequire(new URL('../.tools/package.json', import.meta.url));
let PGlite, pgcrypto;
try {
  const esm = (m) => pathToFileURL(require.resolve(m).replace(/\.cjs$/, '.js')).href;
  ({ PGlite } = await import(esm('@electric-sql/pglite')));
  ({ pgcrypto } = await import(esm('@electric-sql/pglite/contrib/pgcrypto')));
} catch (e) {
  console.log(e.message);
  console.log('skipped: @electric-sql/pglite is not installed (npm i in .tools)');
  process.exit(0);
}

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(readFileSync(new URL('supabase-stub.sql', here), 'utf8'));
const dir = new URL('../supabase/migrations/', here);
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const call = async (fn, args) => {
  const names = Object.keys(args);
  try {
    const r = await one(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, Object.values(args));
    return r.r;
  } catch (e) {
    throw new Error(`${fn}: ${e.message}${e.where ? ' (' + e.where.split('\n')[0] + ')' : ''}`);
  }
};
const fails = async (p, re) => {
  try { await p; } catch (e) { assert.match(e.message, re); return; }
  assert.fail('expected an error ' + re);
};
const game = (id) => one('select * from public.live_games where id = $1', [id]);
const pidOf = async (token) => (await one(`select encode(extensions.digest($1::text, 'sha256'), 'hex') as p`, [token])).p;
/** Move every timestamp of the game, its players' presence and chat back by `s` seconds. */
const age = async (id, s) => {
  const iv = `${s} seconds`;
  await q(`update public.live_games set created_at = created_at - $2::interval, turn_started_at = turn_started_at - $2::interval,
    white_claim_at = white_claim_at - $2::interval, black_claim_at = black_claim_at - $2::interval,
    empty_since = empty_since - $2::interval where id = $1`, [id, iv]);
  await q(`update private.presence set seen_at = seen_at - $2::interval, left_at = left_at - $2::interval where ref = $1`, [id, iv]);
};

const A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', C = 'tokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const pa = await pidOf(A), pb = await pidOf(B);
const setup = '[Board "Standard - Turn Zero"]\n[Mode "5D"]';
const seek = (token, tab, extra = {}) => call('seek_create', {
  p_token: token, p_tab: tab, p_private: false, p_variant: 'Standard - Turn Zero', p_position: 'startpos', p_setup: setup,
  p_start_to_move: 1, p_start_active: 1, p_base_ms: 300000, p_inc_ms: 2000, p_delay_ms: 0, p_tl_delay_ms: 0, p_color: 1, ...extra,
});
const move = (token, tab, id, ply, next, status = null, active = 1) => call('game_apply_move', {
  p_token: token, p_tab: tab, p_id: id, p_ply: ply, p_lan: `m${ply}`, p_san: `s${ply}`, p_full: `f${ply}`, p_lone: true,
  p_next_to_move: next, p_active: active, p_status: status,
});
const flood = () => q('delete from private.recent');

// ---------------------------------------------------------------- seeks
await fails(call('seek_cancel', { p_token: 'short', p_id: 'x' }), /bad player token/);
let s1 = await seek(A, 'tabA1');
assert.equal((await q('select * from public.seeks')).length, 1);
await fails(seek(A, 'tabA1'), /wait a moment/);
await flood();
const s2 = await seek(A, 'tabA1', { p_color: null });
assert.equal((await q('select * from public.seeks')).length, 1, 'one seek per player');
assert.notEqual(s1.id, s2.id);
assert.deepEqual(await call('seek_accept', { p_token: A, p_tab: 'tabA1', p_id: s2.id }), { ignored: true });
// Leaving the lobby takes the public seek away.
await call('leave', { p_token: A, p_tab: 'tabA1' });
assert.equal((await q('select * from public.seeks')).length, 0);
await flood();
s1 = await seek(A, 'tabA1');
let acc = await call('seek_accept', { p_token: B, p_tab: 'tabB1', p_id: s1.id });
assert.equal(acc.id, s1.id);
assert.equal(acc.role, 2);
await fails(call('seek_accept', { p_token: C, p_tab: 'tabC1', p_id: s1.id }), /Game aborted/);
let g = await game(s1.id);
assert.equal(g.white, pa);
assert.equal(g.black, pb);
assert.equal((await q('select * from public.active_players')).length, 2);
await flood();
await fails(seek(A, 'tabA1'), /already in a game/);

// ---------------------------------------------------------------- moves and clocks
const id = s1.id;
await call('game_open', { p_token: A, p_tab: 'tabA1', p_id: id });
await call('game_open', { p_token: B, p_tab: 'tabB1', p_id: id });
assert.deepEqual(await move(B, 'tabB1', id, 0, 2), { error: 'resync' }, 'not your turn');
assert.equal((await move(A, 'tabA1', id, 0, 2)).ok, true);
g = await game(id);
assert.equal(g.color_ticking, null, 'no clock after one action');
assert.deepEqual(await move(B, 'tabB1', id, 0, 1), { error: 'resync' }, 'stale ply');
await move(B, 'tabB1', id, 1, 1);
g = await game(id);
assert.equal(g.color_ticking, 1, 'clock starts at ply 2 for the side to move');
assert.equal(Number(g.white_ms), 300000);
assert.equal(g.moves[1].clk, 300000, 'no increment at ply 2');
await age(id, 10);
await move(A, 'tabA1', id, 2, 2);
g = await game(id);
assert.ok(Math.abs(Number(g.white_ms) - (300000 - 10000 + 2000)) < 500, 'charged 10 s, plus the increment: ' + g.white_ms);
assert.equal(g.color_ticking, 2);
// Abort is no longer possible; resign is.
await call('game_abort', { p_token: B, p_id: id });
assert.equal((await game(id)).result, null);

// ---------------------------------------------------------------- draw offers
await call('game_offer_draw', { p_token: B, p_id: id });
g = await game(id);
assert.equal(g.draw_offer, 2);
await call('game_offer_draw', { p_token: A, p_id: id }); // an offer is open
assert.equal((await game(id)).draw_offer, 2);
await call('game_answer_draw', { p_token: A, p_id: id, p_accept: false });
assert.equal((await game(id)).draw_offer, null);
await call('game_offer_draw', { p_token: B, p_id: id }); // within 2 plies of B's last offer
assert.equal((await game(id)).draw_offer, null);
await move(B, 'tabB1', id, 3, 1);
await move(A, 'tabA1', id, 4, 2);
await call('game_offer_draw', { p_token: A, p_id: id });
await move(B, 'tabB1', id, 5, 1); // a move declines the opponent's offer
assert.equal((await game(id)).draw_offer, null);

// ---------------------------------------------------------------- disconnects and claims
await call('ping', { p_token: A, p_tab: 'tabA1', p_page: 'game', p_ref: id });
await call('leave', { p_token: B, p_tab: 'tabB1' });
g = await game(id);
assert.ok(g.black_claim_at, 'a voluntary leave opens a claim window');
assert.equal(g.black_claim_voluntary, true);
await call('game_claim', { p_token: A, p_id: id, p_draw: false });
assert.equal((await game(id)).result, null, 'not before the window opens');
// B comes back: the window closes.
await call('game_open', { p_token: B, p_tab: 'tabB1', p_id: id });
g = await game(id);
assert.equal(g.black_claim_at, null);
let chat = await call('game_chat', { p_token: A, p_id: id, p_since: 0 });
assert.deepEqual(chat.map((c) => c.notice), ['draw-offered', 'draw-declined', 'draw-offered', 'disconnect-voluntary', 'reconnected']);
// B's pings stop: after the stale time and the cushion the involuntary window opens (60 s).
await q(`update private.presence set seen_at = now() - interval '20 seconds' where player = $1`, [pb]);
await call('ping', { p_token: A, p_tab: 'tabA1', p_page: 'game', p_ref: id });
g = await game(id);
assert.equal(g.black_claim_voluntary, false);
assert.ok(new Date(g.black_claim_at) - Date.now() > 40000, 'about a minute away');
await q(`update public.live_games set black_claim_at = now() - interval '1 second' where id = $1`, [id]);
await call('game_claim', { p_token: A, p_id: id, p_draw: false });
g = await game(id);
assert.equal(g.result, '1-0');
assert.equal(g.termination, 'disconnect');
assert.equal((await q('select * from public.active_players')).length, 0, 'players released at the end');
let rec = await one('select * from public.games where id = $1', [id]);
assert.equal(rec.move_count, 6);
assert.match(rec.record, /\[Termination "Abandonment"\]/);
assert.match(rec.record, /\n1\. f0 \{\[%clk 0:05:00\.0\]\} \/ f1 \{\[%clk 0:05:00\.0\]\}\n2\. f2 /);
assert.match(rec.record, /f5 \{\[%clk [0-9:.]+\]\} 1-0\n$/);
assert.equal((await q('select * from public.player_games where game_id = $1', [id])).length, 2);

// ---------------------------------------------------------------- rematch and the post-game
let r = await call('game_rematch', { p_token: A, p_tab: 'tabA1', p_id: id });
assert.equal(r.waiting, true);
r = await call('game_rematch', { p_token: B, p_tab: 'tabB1', p_id: id });
const id2 = r.id;
assert.equal(r.role, 1, 'colours swap');
g = await game(id2);
assert.equal(g.white, pb);
assert.equal((await game(id)).rematch_id, id2);
// Both leave the finished game: its live row goes.
await call('leave', { p_token: A, p_tab: 'tabA1' });
await call('leave', { p_token: B, p_tab: 'tabB1' });
await one('select private.evaluate($1)', [id]);
assert.equal(await game(id), undefined, 'evicted');
assert.ok(await one('select * from public.games where id = $1', [id]), 'the record stays');

// ---------------------------------------------------------------- abort, abandonment, time
await call('game_open', { p_token: A, p_tab: 'tabA1', p_id: id2 });
await call('game_abort', { p_token: A, p_id: id2 });
g = await game(id2);
assert.equal(g.result, '*');
assert.equal(await one('select * from public.games where id = $1', [id2]), undefined, 'no record without moves');

await flood();
const s3 = await seek(A, 'tabA2', { p_base_ms: 60000, p_inc_ms: 0 });
await call('seek_accept', { p_token: B, p_tab: 'tabB2', p_id: s3.id });
await call('game_open', { p_token: A, p_tab: 'tabA2', p_id: s3.id });
await call('game_open', { p_token: B, p_tab: 'tabB2', p_id: s3.id });
await move(A, 'tabA2', s3.id, 0, 2);
await move(B, 'tabB2', s3.id, 1, 1);
await q(`update public.live_games set turn_started_at = now() - interval '61 seconds' where id = $1`, [s3.id]);
await call('game_check', { p_id: s3.id });
g = await game(s3.id);
assert.equal(g.result, '0-1');
assert.equal(g.termination, 'time');
assert.equal(Number(g.white_ms), 0);

await flood();
const s4 = await seek(A, 'tabA3');
await call('seek_accept', { p_token: B, p_tab: 'tabB3', p_id: s4.id });
await call('game_open', { p_token: A, p_tab: 'tabA3', p_id: s4.id });
await call('game_open', { p_token: B, p_tab: 'tabB3', p_id: s4.id });
await move(A, 'tabA3', s4.id, 0, 2);
await move(B, 'tabB3', s4.id, 1, 1);
await call('leave', { p_token: A, p_tab: 'tabA3' });
await call('leave', { p_token: B, p_tab: 'tabB3' });
g = await game(s4.id);
assert.ok(g.empty_since, 'everyone gone');
await q(`update public.live_games set empty_since = now() - interval '6 minutes' where id = $1`, [s4.id]);
await one('select private.sweep()');
g = await game(s4.id);
assert.equal(g.termination, 'abandonment');
assert.equal(g.result, '1/2-1/2');

// ---------------------------------------------------------------- a game against Kairos
await flood();
const e = await call('engine_game_create', {
  p_token: C, p_tab: 'tabC1', p_variant: 'Standard - Turn Zero', p_position: 'startpos', p_setup: setup,
  p_start_to_move: 1, p_start_active: 1, p_base_ms: 300000, p_inc_ms: 0, p_delay_ms: 0, p_tl_delay_ms: 3000,
  p_color: 1, p_level: 4, p_version: 'abc1234', p_book: true,
});
await call('game_open', { p_token: C, p_tab: 'tabC1', p_id: e.id });
await move(C, 'tabC1', e.id, 0, 2);
await move(C, 'tabC1', e.id, 1, 1, null, 2); // Kairos's action, sent by the player's page
g = await game(e.id);
assert.equal(g.turn_delay_ms, 6000, '3 s per active timeline (2)');
await move(C, 'tabC1', e.id, 2, 2);
g = await game(e.id);
assert.equal(g.color_ticking, 2, "Kairos's clock runs");
await q(`update public.live_games set turn_started_at = now() - interval '30 seconds' where id = $1`, [e.id]);
await call('leave', { p_token: C, p_tab: 'tabC1' });
g = await game(e.id);
assert.equal(g.engine_frozen, true);
assert.equal(g.color_ticking, null, "Kairos's clock stops while its player is away");
assert.equal(g.black_claim_at, null);
assert.equal(g.white_claim_at, null, 'nobody claims against Kairos');
await call('game_open', { p_token: C, p_tab: 'tabC1', p_id: e.id });
g = await game(e.id);
assert.equal(g.color_ticking, 2);
assert.ok(Date.now() - new Date(g.turn_started_at) < 2000, 'its turn starts again');
await call('game_offer_draw', { p_token: C, p_id: e.id });
assert.equal((await game(e.id)).draw_offer, null, 'no draws against Kairos');
await fails(call('game_say', { p_token: C, p_id: e.id, p_text: 'hi' }), /only for private/);
await move(C, 'tabC1', e.id, 3, 1, 'checkmate');
g = await game(e.id);
assert.equal(g.result, '0-1');
rec = await one('select * from public.engine_games where game_id = $1', [e.id]);
assert.equal(rec.score, 1);
assert.equal(rec.strength_level, 4);
assert.match((await one('select record from public.games where id = $1', [e.id])).record, /\[Black "Kairos \(Level 4\)"\]/);
r = await call('game_rematch', { p_token: C, p_tab: 'tabC1', p_id: e.id });
assert.ok(r.id, 'a rematch against Kairos starts at once');
assert.equal((await game(r.id)).engine_color, 1);

// ---------------------------------------------------------------- a private challenge with chat
await flood();
const pc = await seek(A, 'tabA4', { p_private: true });
assert.equal((await q('select * from public.seeks where id = $1', [pc.id])).length, 1);
let st = await call('challenge_open', { p_token: B, p_tab: 'tabB4', p_id: pc.id });
assert.equal(st.kind, 'open');
assert.equal(st.owner, false);
st = await call('challenge_open', { p_token: A, p_tab: 'tabA4', p_id: pc.id });
assert.equal(st.owner, true);
await call('seek_accept', { p_token: B, p_tab: 'tabB4', p_id: pc.id });
st = await call('challenge_open', { p_token: A, p_tab: 'tabA4', p_id: pc.id });
assert.equal(st.kind, 'game');
await call('game_open', { p_token: A, p_tab: 'tabA4', p_id: pc.id });
await call('game_say', { p_token: A, p_id: pc.id, p_text: 'good luck' });
await fails(call('game_say', { p_token: A, p_id: pc.id, p_text: 'good luck' }), /just said that/);
await fails(call('game_say', { p_token: A, p_id: pc.id, p_text: 'x'.repeat(141) }), /cannot be sent/);
chat = await call('game_chat', { p_token: B, p_id: pc.id, p_since: 0 });
assert.equal(chat[0].message, 'good luck');
assert.deepEqual(await call('game_chat', { p_token: C, p_id: pc.id, p_since: 0 }), [], 'only players read the chat');

// A challenge whose owner has been away 10 minutes expires.
await call('game_abort', { p_token: A, p_id: pc.id });
await flood();
const pc2 = await seek(A, 'tabA5', { p_private: true });
await q(`update public.seeks set owner_away_since = now() - interval '11 minutes' where id = $1`, [pc2.id]);
await one('select private.sweep()');
assert.equal((await q('select * from public.seeks where id = $1', [pc2.id])).length, 0);

console.log('online-sql: seeks, challenges, clocks, draws, claims, abandonment, time, Kairos games, rematch and chat passed');
