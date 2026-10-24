// Accounts and rated games (supabase/migrations) in PGlite: signing in links a browser's token to
// a profile (made on first use, with the imported Discord rating when there is one), who may play
// rated games (signed in, timed, rated variants, never yourself), Glicko-2 changes when a rated
// game ends (none when aborted), the records' ratings, rematches and the deviation's growth.
// Needs @electric-sql/pglite (npm i in .tools): node tests/accounts-sql.mjs
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
    return (await one(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, Object.values(args))).r;
  } catch (e) {
    throw new Error(`${fn}: ${e.message}`);
  }
};
const fails = async (p, re) => {
  try { await p; } catch (e) { assert.match(e.message, re); return; }
  assert.fail('expected an error ' + re);
};
/** Act as signed-in user `u` (null: no session). */
const as = async (u) => db.exec(`set request.jwt.claim.sub = '${u || ''}'`);
const flood = () => q('delete from private.recent');
const game = (id) => one('select * from public.live_games where id = $1', [id]);
const profile = (u) => one('select * from public.profiles where user_id = $1', [u]);

const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222', U3 = '33333333-3333-3333-3333-333333333333';
await q(`insert into auth.users (id, raw_user_meta_data) values
  ($1, '{"full_name": "Alice", "custom_claims": {"global_name": "Alice D"}}'),
  ($2, '{"full_name": "Bob G"}'),
  ($3, '{"name": "Carol"}')`, [U1, U2, U3]);
await q(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', '9001'), ($2, 'google', 'g-2'), ($3, 'discord', '9003')`, [U1, U2, U3]);
await q(`insert into private.rating_import (discord_id, name, rating, games) values ('9001', 'alice', 1900, 50), ('9999', 'nobody', 2100, 5)`);

const A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', A2 = 'tokenA2A2A2A2A2A2A2A2A2A2A2A2A2A2A2A';
const B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', C = 'tokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', G = 'tokenGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG';
const setup = '[Board "Standard - Turn Zero"]\n[Mode "5D"]';
const seek = (token, tab, extra = {}) => call('seek_create', {
  p_token: token, p_tab: tab, p_private: false, p_variant: 'Standard - Turn Zero', p_position: 'startpos', p_setup: setup,
  p_start_to_move: 1, p_start_active: 1, p_base_ms: 300000, p_inc_ms: 2000, p_delay_ms: 0, p_tl_delay_ms: 0, p_color: 1, ...extra,
});
const move = (token, tab, id, ply, next, status = null) => call('game_apply_move', {
  p_token: token, p_tab: tab, p_id: id, p_ply: ply, p_lan: `m${ply}`, p_san: `s${ply}`, p_full: `f${ply}`, p_lone: true,
  p_next_to_move: next, p_active: 1, p_status: status,
});

// ---------------------------------------------------------------- signing in
await as(null);
await fails(call('account_link', { p_token: A }), /Sign in first/);
await as(U1);
let me = await call('account_link', { p_token: A });
assert.equal(me.name, 'Alice D', 'Discord display name');
assert.equal(me.rating, 1900, 'imported rating');
assert.equal(me.rd, 80, 'deviation from the imported game count');
assert.equal(me.provisional, false);
assert.equal(me.imported, true);
assert.equal((await one(`select claimed_by from private.rating_import where discord_id = '9001'`)).claimed_by, U1);
me = await call('account_link', { p_token: A2 }); // a second browser of the same account
assert.equal(me.rating, 1900);
assert.equal((await q('select * from private.player_users where user_id = $1', [U1])).length, 2);
await as(U2);
me = await call('account_link', { p_token: B });
assert.equal(me.name, 'Bob G');
assert.equal(me.rating, 1500);
assert.equal(me.provisional, true, 'a new rating is provisional');
await as(U3);
me = await call('account_link', { p_token: C });
assert.equal(me.rating, 1500, 'a Discord id not in the list starts fresh');
await as(null);
assert.equal((await call('account_me', { p_token: A })).name, 'Alice D');
assert.equal(await call('account_me', { p_token: G }), null, 'a guest has no account');

// ---------------------------------------------------------------- who may play rated
await fails(seek(G, 'tabG1', { p_rated: true }), /Sign in to play rated/);
await flood();
await fails(seek(A, 'tabA1', { p_rated: true, p_base_ms: null }), /need a clock/);
await flood();
await fails(seek(A, 'tabA1', { p_rated: true, p_variant: 'Small' }), /Rated games are played in/);
await flood();
const s1 = await seek(A, 'tabA1', { p_rated: true });
let sk = await one('select * from public.seeks where id = $1', [s1.id]);
assert.equal(sk.rated, true);
assert.equal(sk.owner_name, 'Alice D');
assert.equal(sk.owner_rating, 1900);
await fails(call('seek_accept', { p_token: G, p_tab: 'tabG1', p_id: s1.id }), /Sign in to play rated/);
await fails(call('seek_accept', { p_token: A2, p_tab: 'tabA2', p_id: s1.id }), /against yourself/);
const acc = await call('seek_accept', { p_token: B, p_tab: 'tabB1', p_id: s1.id });
let g = await game(acc.id);
assert.equal(g.rated, true);
assert.equal(g.white_user, U1);
assert.equal(g.black_user, U2);
assert.equal(g.white_name, 'Alice D');
assert.equal(g.black_name, 'Bob G');
assert.equal(Math.round(g.white_rating), 1900);
assert.equal(Math.round(g.black_rating), 1500);
// The account's other browser can't start a second game meanwhile.
await flood();
await fails(seek(A2, 'tabA2'), /already in a game/);

// ---------------------------------------------------------------- a rated game ends
await move(A, 'tabA1', g.id, 0, 2);
await move(B, 'tabB1', g.id, 1, 1);
await call('game_resign', { p_token: A, p_id: g.id }); // the 1900 loses to the provisional 1500
g = await game(g.id);
assert.equal(g.result, '0-1');
assert.ok(g.white_diff < 0 && g.black_diff > 0, `diffs ${g.white_diff} ${g.black_diff}`);
assert.ok(g.black_diff > -g.white_diff, 'the provisional rating moves further');
const p1 = await profile(U1), p2 = await profile(U2);
assert.equal(p1.games, 1);
assert.equal(p2.games, 1);
assert.equal(Math.round(p1.rating), 1900 + g.white_diff);
assert.ok(p2.rd < 500, 'the deviation shrinks');
const logged = await one('select * from public.games where id = $1', [g.id]);
assert.equal(logged.rated, true);
assert.equal(logged.white_name, 'Alice D');
assert.match(logged.record, /\[Event "Rated online game"\]/);
assert.match(logged.record, /\[WhiteElo "1900"\]/);
assert.match(logged.record, /\[BlackElo "1500"\]/);
assert.match(logged.record, new RegExp(`\\[WhiteRatingDiff "${g.white_diff}"\\]`));
const pg = await q('select * from public.player_games where game_id = $1 order by color', [g.id]);
assert.equal(pg[0].user_id, U1);
assert.equal(Math.round(pg[0].rating_before), 1900);
assert.equal(pg[0].rating_diff, g.white_diff);
assert.ok(pg[1].rd_before > 400, 'the deviation going in is kept');

// ---------------------------------------------------------------- a rated rematch
await call('game_rematch', { p_token: A, p_tab: 'tabA1', p_id: g.id });
const rm = await call('game_rematch', { p_token: B, p_tab: 'tabB1', p_id: g.id });
let r = await game(rm.id);
assert.equal(r.rated, true, 'a rated game\'s rematch is rated');
assert.equal(r.white_user, U2, 'sides swapped');
assert.equal(Math.round(r.white_rating), Math.round(p2.rating), 'fresh ratings going in');

// ---------------------------------------------------------------- an aborted rated game changes nothing
await call('game_abort', { p_token: A, p_id: rm.id });
r = await game(rm.id);
assert.equal(r.result, '*');
assert.equal(r.white_diff, null);
assert.equal((await profile(U1)).games, 1);

// ---------------------------------------------------------------- a draw, and casual games
await flood();
const s2 = await seek(C, 'tabC1', { p_rated: true, p_color: 2 });
const acc2 = await call('seek_accept', { p_token: B, p_tab: 'tabB2', p_id: s2.id });
await move(B, 'tabB2', acc2.id, 0, 2);
await move(C, 'tabC1', acc2.id, 1, 1);
await call('game_offer_draw', { p_token: C, p_id: acc2.id });
await call('game_answer_draw', { p_token: B, p_id: acc2.id, p_accept: true });
g = await game(acc2.id);
assert.equal(g.result, '1/2-1/2');
assert.ok(g.white_diff !== null && g.black_diff !== null);
await flood();
const s3 = await seek(A, 'tabA1');
const acc3 = await call('seek_accept', { p_token: G, p_tab: 'tabG1', p_id: s3.id });
g = await game(acc3.id);
assert.equal(g.rated, false);
assert.equal(g.white_name, 'Alice D', 'a signed-in player is named in casual games too');
assert.equal(g.black_name, null);
await move(A, 'tabA1', g.id, 0, 2);
await move(G, 'tabG1', g.id, 1, 1);
await call('game_resign', { p_token: G, p_id: g.id });
assert.equal((await game(g.id)).white_diff, null, 'casual games change no rating');
assert.equal((await profile(U1)).games, 1);
assert.match((await one('select record from public.games where id = $1', [g.id])).record, /\[Black "Anonymous"\]/);

// ---------------------------------------------------------------- the deviation grows while away
await q(`update public.profiles set rd = 60, rated_at = now() - interval '365 days' where user_id = $1`, [U1]);
me = await call('account_me', { p_token: A });
assert.ok(me.rd > 100 && me.rd <= 500, `a year away: ${me.rd}`);

// ---------------------------------------------------------------- profile pages
let view = await call('profile_view', { p_user: U1 });
assert.equal(view.name, 'Alice D');
assert.deepEqual(view.rated, { games: 1, wins: 0, draws: 0, losses: 1 });
assert.deepEqual(view.people, { games: 2, wins: 1, draws: 0, losses: 1 }, 'casual games count among games against people');
assert.equal(view.kairos.games, 0);
assert.equal(view.history.length, 1);
assert.equal(view.history[0][1], 1900 + (await game((await one('select game_id from public.player_games where user_id = $1 and rating_diff is not null', [U1])).game_id)).white_diff);
let list = await call('profile_games', { p_user: U1, p_kind: 'people' });
assert.equal(list.length, 2, 'the rated game and the casual one (the aborted rematch had no moves: never recorded)');
assert.equal(list.find((r) => r.rated && r.result !== '*').opponent, 'Bob G');
assert.ok(list.find((r) => r.rated && r.result !== '*').diff < 0);
assert.deepEqual(await call('profile_games', { p_user: U1, p_kind: 'kairos' }), []);
assert.equal(await call('profile_view', { p_user: '44444444-4444-4444-4444-444444444444' }), null);

// ---------------------------------------------------------------- signing out
await call('account_unlink', { p_token: A2 });
assert.equal(await call('account_me', { p_token: A2 }), null);

// Nobody writes profiles or reads the import list directly.
await db.exec('set role anon');
await fails(db.exec(`update public.profiles set rating = 3000`), /permission denied/);
await fails(db.exec(`select * from private.rating_import`), /permission denied/);
await db.exec('reset role');
console.log('accounts-sql: sign-in, imported ratings, rated seeks, Glicko-2 results, rematch, abort, draw and decay passed');
