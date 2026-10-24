// Profiles, challenges to a player and the community pages (supabase/migrations) in PGlite:
// renaming (rules, taken names, once a month, the games' records follow), the bio, closing an
// account (games stay as "Anonymous"; a barred account's sign-in stays barred), challenges sent
// from a profile (only their player accepts; incoming list; declining), the activity timeline and
// the players list. Needs @electric-sql/pglite (npm i in .tools): node tests/profiles-sql.mjs
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
const call = async (fn, args = {}) => {
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
const as = async (u) => db.exec(`set request.jwt.claim.sub = '${u || ''}'`);
const flood = () => q('delete from private.recent');

const OWNER = 'e53c7544-54fa-46ed-b276-4fc2554584ca';
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222', U3 = '33333333-3333-3333-3333-333333333333';
await q(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name": "Owner"}'), ($2, '{"full_name": "Ann"}'), ($3, '{"full_name": "Ben"}'), ($4, '{"full_name": "Cy"}')`, [OWNER, U1, U2, U3]);
await q(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', 'd-ann'), ($2, 'discord', 'd-ben'), ($3, 'google', 'g-cy')`, [U1, U2, U3]);
const O = 'tokenOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', C = 'tokenCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
for (const [u, t] of [[OWNER, O], [U1, A], [U2, B], [U3, C]]) { await as(u); await call('account_link', { p_token: t }); }
await as(null);
const setup = '[Board "Standard - Turn Zero"]\n[Mode "5D"]';
const seek = (token, tab, extra = {}) => call('seek_create', {
  p_token: token, p_tab: tab, p_private: false, p_variant: 'Standard - Turn Zero', p_position: 'startpos', p_setup: setup,
  p_start_to_move: 1, p_start_active: 1, p_base_ms: 300000, p_inc_ms: 2000, p_delay_ms: 0, p_tl_delay_ms: 0, p_color: 1, ...extra,
});
const move = (token, tab, id, ply, next) => call('game_apply_move', {
  p_token: token, p_tab: tab, p_id: id, p_ply: ply, p_lan: `m${ply}`, p_san: `s${ply}`, p_full: `f${ply}`, p_lone: true,
  p_next_to_move: next, p_active: 1, p_status: null,
});
/** A finished rated game, a (White) beating b. */
const play = async (a, b) => {
  await flood();
  const s = await seek(a, 'tabA', { p_rated: true });
  await call('seek_accept', { p_token: b, p_tab: 'tabB', p_id: s.id });
  await move(a, 'tabA', s.id, 0, 2);
  await move(b, 'tabB', s.id, 1, 1);
  await call('game_resign', { p_token: b, p_id: s.id });
  return s.id;
};

// ---------------------------------------------------------------- challenges to a player
await flood();
await fails(seek(A, 'tabA', { p_to_user: U1 }), /yourself/);
await fails(seek('tokenGuestGuestGuestGuestGuestGuest1', 'tabG', { p_to_user: U2 }), /Sign in/);
let ch = await seek(A, 'tabA', { p_to_user: U2, p_rated: true });
let sk = await one('select * from public.seeks where id = $1', [ch.id]);
assert.equal(sk.private, true, 'a challenge to a player is private');
assert.equal(sk.to_name, 'Ben');
await as(U2);
let inc = await call('challenges_incoming');
assert.deepEqual(inc.map((c) => [c.id, c.owner_name, c.owner_user, c.rated]), [[ch.id, 'Ann', U1, true]], 'Ben sees it');
await as(U3);
assert.deepEqual(await call('challenges_incoming'), [], 'nobody else does');
assert.equal(await call('challenge_decline', { p_id: ch.id }), false, 'nor can decline it');
await as(null);
let open = await call('challenge_open', { p_token: C, p_tab: 'tabC', p_id: ch.id });
assert.equal(open.seek.to_name, 'Ben', 'its page says whom it is for');
await fails(call('seek_accept', { p_token: C, p_tab: 'tabC', p_id: ch.id }), /This challenge is for Ben/);
const g1 = await call('seek_accept', { p_token: B, p_tab: 'tabB', p_id: ch.id });
assert.equal(g1.id, ch.id, 'Ben accepts: the game starts');
await call('game_abort', { p_token: A, p_id: ch.id });
await flood();
ch = await seek(A, 'tabA', { p_to_user: U2 });
await as(U2);
assert.equal(await call('challenge_decline', { p_id: ch.id }), true);
assert.equal((await q('select * from public.seeks where id = $1', [ch.id])).length, 0, 'declined: it goes');
await as(null);

// ---------------------------------------------------------------- renaming and the bio
const won = await play(A, B);
await as(U1);
await fails(call('account_update', { p_name: 'a' }), /3 to 20/);
await fails(call('account_update', { p_name: 'bad name' }), /3 to 20/);
await fails(call('account_update', { p_name: 'ben' }), /taken/);
let me = await call('account_update', { p_name: 'Annie_5D', p_bio: '  5D player.  ' });
assert.equal(me.name, 'Annie_5D');
assert.equal(me.bio, '5D player.');
let g = await one('select * from public.games where id = $1', [won]);
assert.equal(g.white_name, 'Annie_5D', 'the games follow');
assert.match(g.record, /\[White "Annie_5D"\]/);
await fails(call('account_update', { p_name: 'Annie2' }), /again on/);
me = await call('account_update', { p_name: 'Annie_5D', p_bio: '' });
assert.equal(me.bio, null, 'an empty bio clears it; the same name is no change');
await fails(call('account_update', { p_bio: 'x'.repeat(401) }), /400/);
await as(null);

// ---------------------------------------------------------------- the profile, activity and community
await q('delete from private.presence');
await q("update public.profiles set seen_at = now() - interval '1 hour'");
await q(`insert into private.presence (player, tab, page, seen_at) values ((select encode(extensions.digest($1::text, 'sha256'), 'hex')), 't1', 'lobby', now())`, [B]);
const view = await call('profile_view', { p_user: U2 });
assert.equal(view.online, true, 'Ben is on the site');
assert.ok(view.seen_at);
assert.ok(view.play_ms >= 0);
assert.ok(view.progress < 0, 'Ben lost his rated game');
const act = await call('profile_activity', { p_user: U1 });
assert.equal(act.games.length, 1);
assert.equal(act.games[0].opponent, 'Ben');
assert.equal(act.games[0].score, 1);
assert.ok(act.games[0].diff > 0 && act.games[0].after > 1500);
const all = await call('community');
assert.equal(all.length, 4);
assert.deepEqual(all.filter((p) => p.online).map((p) => p.name), ['Ben']);
// Any page of a signed-in player checks for challenges: that marks them online too.
await as(U3);
await call('challenges_incoming');
await as(null);
assert.deepEqual((await call('community')).filter((p) => p.online).map((p) => p.name).sort(), ['Ben', 'Cy']);

// ---------------------------------------------------------------- closing an account
await as(U2);
await fails(call('account_delete', { p_confirm: 'ben' }), /Type your name/);
await as(OWNER);
await call('admin_ban', { p_user: U2, p_banned: true });
await as(U2);
assert.deepEqual(await call('account_delete', { p_confirm: 'Ben' }), { closed: true });
await as(null);
g = await one('select * from public.games where id = $1', [won]);
assert.equal(g.black_user, null);
assert.match(g.record, /\[Black "Anonymous"\]/, 'the game stays, played by Anonymous');
assert.equal((await q('select * from public.profiles where user_id = $1', [U2])).length, 0);
assert.equal((await q('select * from auth.users where id = $1', [U2])).length, 0);
// The same Discord account signs up again: still barred.
const U2b = '44444444-4444-4444-4444-444444444444';
await q(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name": "Ben"}')`, [U2b]);
await q(`insert into auth.identities (user_id, provider, provider_id) values ($1, 'discord', 'd-ben')`, [U2b]);
await as(U2b);
assert.equal((await call('account_link', { p_token: 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2' })).banned, true, 'a closed barred account stays barred');
await as(OWNER);
await fails(call('account_delete', { p_confirm: 'Owner' }), /last admin/);
await as(null);
console.log('profiles-sql: challenges to a player, renaming and the bio, profile, activity, community and closing an account passed');
