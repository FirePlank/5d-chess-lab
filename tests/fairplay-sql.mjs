// Admins, a guest's history moving into their account, and fair play (supabase/migrations) in
// PGlite: promoting admins, the page's interaction signals, the detector's key, queue, evidence
// and cases, and the admins' review (dismissing clears the evidence so far; banning bars rated
// play). Needs @electric-sql/pglite (npm i in .tools): node tests/fairplay-sql.mjs
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const as = async (u) => db.exec(`set request.jwt.claim.sub = '${u || ''}'`);
const flood = () => q('delete from private.recent');
const KEY = 'test-detector-key';
await q(`insert into private.detector_keys (hash) values ($1)`, [createHash('sha256').update(KEY).digest('hex')]);

const OWNER = 'e53c7544-54fa-46ed-b276-4fc2554584ca';
const U1 = '11111111-1111-1111-1111-111111111111', U2 = '22222222-2222-2222-2222-222222222222';
await q(`insert into auth.users (id, raw_user_meta_data) values ($1, '{"full_name": "Owner"}'), ($2, '{"full_name": "Ann"}'), ($3, '{"full_name": "Ben"}')`, [OWNER, U1, U2]);
const O = 'tokenOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOO', A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const setup = '[Board "Standard - Turn Zero"]\n[Mode "5D"]';
const seek = (token, tab, extra = {}) => call('seek_create', {
  p_token: token, p_tab: tab, p_private: false, p_variant: 'Standard - Turn Zero', p_position: 'startpos', p_setup: setup,
  p_start_to_move: 1, p_start_active: 1, p_base_ms: 300000, p_inc_ms: 2000, p_delay_ms: 0, p_tl_delay_ms: 0, p_color: 1, ...extra,
});
const move = (token, tab, id, ply, next, signals = null) => call('game_apply_move', {
  p_token: token, p_tab: tab, p_id: id, p_ply: ply, p_lan: `m${ply}`, p_san: `s${ply}`, p_full: `f${ply}`, p_lone: true,
  p_next_to_move: next, p_active: 1, p_status: null, p_signals: signals,
});
/** A finished game between tokens a (White) and b, two actions each, rated or not. */
const play = async (a, b, rated) => {
  await flood();
  const s = await seek(a, 'tabA', { p_rated: rated });
  await call('seek_accept', { p_token: b, p_tab: 'tabB', p_id: s.id });
  await move(a, 'tabA', s.id, 0, 2, { hidden_ms: 0, blurs: 0 });
  await move(b, 'tabB', s.id, 1, 1, { hidden_ms: 4200, blurs: 1 });
  await move(a, 'tabA', s.id, 2, 2, { hidden_ms: 0, blurs: 0, engine_tab: true });
  await move(b, 'tabB', s.id, 3, 1);
  await call('game_resign', { p_token: b, p_id: s.id });
  return s.id;
};

// ---------------------------------------------------------------- a guest's history moves into the account
const casual = await play(A, B, false); // both guests
await q(`insert into private.puzzle_players (player, rating, rd, vol, rounds) values ((select encode(extensions.digest($1::text, 'sha256'), 'hex')), 1720, 200, 0.09, 3)`, [A]);
await q(`insert into private.puzzle_rounds (player, puzzle, win, rated) select (select encode(extensions.digest($1::text, 'sha256'), 'hex')), id, true, true from public.puzzles limit 3`, [A]);
await as(U1);
await call('account_link', { p_token: A });
let g = await one('select * from public.games where id = $1', [casual]);
assert.equal(g.white_user, U1, 'a guest\'s game joins the account');
assert.equal(g.white_name, 'Ann');
assert.match(g.record, /\[White "Ann"\]/);
assert.equal((await one('select user_id from public.player_games where game_id = $1 and color = 1', [casual])).user_id, U1);
let dash = await call('puzzle_dashboard', { p_token: A });
assert.equal(dash.rating, 1720, 'the guest puzzle rating moved to the account');
assert.equal(dash.played, 3);
await as(U2);
await call('account_link', { p_token: B });
await as(OWNER);
let me = await call('account_link', { p_token: O });
assert.equal(me.admin, true, 'the owner is an admin');
await as(null);

// ---------------------------------------------------------------- admins
await as(U1);
await fails(call('admin_set', { p_user: U2, p_admin: true }), /Admins only/);
assert.equal(await call('admin_status', {}), null, 'no status for non-admins');
await as(OWNER);
assert.equal((await call('admin_set', { p_user: U1, p_admin: true })).admin, true);
assert.equal((await call('admin_set', { p_user: U1, p_admin: false })).admin, false);
await fails(call('admin_set', { p_user: OWNER, p_admin: false }), /last admin/);
await as(null);

// ---------------------------------------------------------------- signals, the queue and evidence
const rated = await play(A, B, true);
const sig = await q('select * from private.move_signals where game_id = $1 order by ply', [rated]);
assert.deepEqual(sig.map((s) => s.ply), [0, 1, 2], 'one row per action that sent signals');
assert.equal(sig[1].side, 2);
await db.exec('set role anon');
await fails(db.exec('select * from private.move_signals'), /permission denied/);
await db.exec('reset role');
await fails(call('fairplay_queue', { p_key: 'wrong' }), /not the detector/);
let queue = await call('fairplay_queue', { p_key: KEY });
assert.deepEqual(queue.map((x) => x.id), [rated], 'only rated games between people');
assert.equal(queue[0].signals['2'].engine_tab, true);
await call('fairplay_store', { p_key: KEY, p_game: rated, p_user: U1, p_color: 1, p_outcome: 'analysed', p_evidence: [{ ply: 0, outcome: 'top' }] });
await call('fairplay_store', { p_key: KEY, p_game: rated, p_user: U2, p_color: 2, p_outcome: 'analysed', p_evidence: [] });
assert.deepEqual(await call('fairplay_queue', { p_key: KEY }), [], 'assessed games leave the queue');
let hist = await call('fairplay_history', { p_key: KEY, p_user: U1 });
assert.equal(hist.open, false);
assert.equal(hist.games.length, 1);
assert.ok(hist.games[0].rating > 0 && hist.games[0].rd > 0, 'the rating going in');

// ---------------------------------------------------------------- cases and their review
const opened = await call('fairplay_open', { p_key: KEY, p_user: U1, p_reason: 'moves', p_score: 7.2, p_detail: { games: 1 } });
assert.equal(opened.name, 'Ann', 'the new case, for the admins’ channel');
const caseId = opened.id;
assert.equal(await call('fairplay_open', { p_key: KEY, p_user: U1, p_reason: 'moves', p_score: 8, p_detail: {} }), null, 'one open case at a time');
assert.equal((await call('fairplay_history', { p_key: KEY, p_user: U1 })).open, true);
await as(U2);
await fails(call('fairplay_cases', { p_status: 'open' }), /Admins only/);
await as(OWNER);
assert.equal((await call('admin_status', {})).open_cases, 1);
const list = await call('fairplay_cases', { p_status: 'open' });
assert.equal(list[0].name, 'Ann');
const view = await call('fairplay_case', { p_case: caseId });
assert.equal(view.games.length, 1);
assert.equal(view.games[0].signals['2'].engine_tab, true, 'the player\'s own signals');
assert.equal(view.games[0].signals['1'], undefined, 'not the opponent\'s');
await call('fairplay_decide', { p_case: caseId, p_action: 'dismiss', p_note: 'strong player' });
assert.equal((await call('fairplay_history', { p_key: KEY, p_user: U1 })).games.length, 0, 'a dismissed case\'s evidence stops counting');
assert.equal((await call('admin_status', {})).open_cases, 0);

// A ban bars rated play.
const c2 = (await call('fairplay_open', { p_key: KEY, p_user: U2, p_reason: 'engine-tab', p_score: null, p_detail: {} })).id;
await call('fairplay_decide', { p_case: c2, p_action: 'ban', p_note: 'confirmed' });
await as(null);
await flood();
await fails(seek(B, 'tabB', { p_rated: true }), /barred from rated games/);
await flood();
const s = await seek(A, 'tabA', { p_rated: true });
await fails(call('seek_accept', { p_token: B, p_tab: 'tabB', p_id: s.id }), /barred from rated games/);
assert.equal((await call('account_me', { p_token: B })).banned, true);
await as(OWNER);
await call('admin_ban', { p_user: U2, p_banned: false });
await as(null);
assert.equal((await call('account_me', { p_token: B })).banned, false);

// The analysis board in another window or on another device: matches of the live position (from
// action 6 on) by the player's account or their browser's fingerprint; a spectator's don't count.
{
  await flood();
  const s = await seek(A, 'tabA', { p_rated: true });
  await call('seek_accept', { p_token: B, p_tab: 'tabB', p_id: s.id });
  const FP_B = 'b'.repeat(32);
  for (let ply = 0; ply < 7; ply++) {
    const [t, tab] = ply % 2 ? [B, 'tabB'] : [A, 'tabA'];
    await call('game_apply_move', { p_token: t, p_tab: tab, p_id: s.id, p_ply: ply, p_lan: `m${ply}`, p_san: `s${ply}`, p_full: `f${ply}`,
      p_lone: true, p_next_to_move: ply % 2 ? 1 : 2, p_active: 1, p_status: null, p_signals: ply % 2 ? { fp: FP_B } : null, p_key: `key${ply + 1}` });
  }
  // Seven actions: Black (Ben) to move at key7.
  await as(null);
  assert.equal(await call('fairplay_seen', { p_key: 'key6', p_fp: 'c'.repeat(32) }), false, 'a guest browser with no live game');
  assert.equal(await call('fairplay_seen', { p_key: 'key6', p_fp: FP_B }), true, 'Ben’s browser, signed out: keep sending');
  assert.equal((await q('select * from private.analysis_matches where game_id = $1', [s.id])).length, 0, 'an old position is no match');
  await call('fairplay_seen', { p_key: 'key7', p_fp: FP_B });
  await as(U2);
  assert.equal(await call('fairplay_seen', { p_key: 'key7' }), true, 'Ben’s account');
  await as(OWNER);
  assert.equal(await call('fairplay_seen', { p_key: 'key7', p_fp: 'd'.repeat(32) }), false, 'a spectator has no live game');
  await as(null);
  const m = await q('select * from private.analysis_matches where game_id = $1', [s.id]);
  assert.deepEqual(m.map((x) => [x.ply, x.side, x.user_id, x.via]), [[7, 2, U2, 'browser']], 'Ben’s matches of the current position');
  await call('game_resign', { p_token: B, p_id: s.id });
  const qd = (await call('fairplay_queue', { p_key: KEY })).find((x) => x.id === s.id);
  assert.deepEqual(qd.matches, [{ ply: 7, side: 2, via: 'browser' }], 'the detector sees the match');
  await one('select private.sweep()');
  assert.equal((await q('select * from private.position_keys where game_id = $1', [s.id])).length, 0, 'position hashes go with the game');
  assert.equal((await q('select * from private.live_prints where game_id = $1', [s.id])).length, 0, 'and the live fingerprints');
  await call('fairplay_store', { p_key: KEY, p_game: s.id, p_user: U1, p_color: 1, p_outcome: 'analysed', p_evidence: [] });
  await call('fairplay_store', { p_key: KEY, p_game: s.id, p_user: U2, p_color: 2, p_outcome: 'analysed', p_evidence: [] });
}

// The dispatcher does nothing without pg_net (as here): no error.
await one('select private.fairplay_dispatch()');
assert.equal((await one('select public.fairplay_ready() as r')).r, false, 'not ready without pg_net');

// With pg_net and the token in Vault (stand-ins that record the requests): fresh rated games start
// the detector.
await db.exec(`create schema net; create table net.sent (url text, body jsonb, headers jsonb);
  create function net.http_post(url text, body jsonb, headers jsonb) returns bigint language sql as
    'insert into net.sent values (url, body, headers) returning 1';
  create schema vault; create view vault.decrypted_secrets as select * from (values
    ('github_fairplay_token', 'ghtoken')) s(name, decrypted_secret);`);
let sent;
assert.equal((await one('select public.fairplay_ready() as r')).r, false, 'nor with too short a token');
await db.exec(`create or replace view vault.decrypted_secrets as select * from (values
    ('github_fairplay_token', 'github_pat_0123456789abcdef')) s(name, decrypted_secret);`);
assert.equal((await one('select public.fairplay_ready() as r')).r, true, 'ready with pg_net and the token');
// The dispatcher: a rated game that just ended and waits for assessment starts one run.
await play(A, B, true);
await one('select private.fairplay_dispatch()');
await one('select private.fairplay_dispatch()');
sent = await q(`select * from net.sent where url like 'https://api.github.com/%'`);
assert.equal(sent.length, 1, 'one run for fresh games, not one per look');
assert.equal(sent[0].headers.Authorization, 'Bearer github_pat_0123456789abcdef');
await q(`update public.games set ended_at = now() - interval '1 hour'`);
await q('delete from private.fairplay_runs');
await one('select private.fairplay_dispatch()');
assert.equal((await q(`select * from net.sent where url like 'https://api.github.com/%'`)).length, 1, 'no run when no game ended lately');
console.log('fairplay-sql: admins, guest history, signals, detector queue and evidence, cases, dismiss and ban, analysis matches and the dispatcher passed');
