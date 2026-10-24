// The puzzle database (supabase/migrations) in PGlite: the puzzles load, the next puzzle follows
// the theme, rating range and difficulty and skips played ones, rounds rate once, the dashboard.
// Needs @electric-sql/pglite (npm i -D in tests/ or .tools/): node tests/puzzles-sql.mjs
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
await db.exec(`
  create schema extensions;
  create role anon; create role authenticated; create role service_role;
`);
const dir = new URL('../supabase/migrations/', here);
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));

const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const call = async (fn, args) => {
  const names = Object.keys(args);
  const r = await one(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, Object.values(args));
  return r.r;
};

const A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const total = +(await one('select count(*) as n from public.puzzles')).n;
assert.ok(total > 1000, `puzzles loaded: ${total}`);
const sample = await one('select * from public.puzzles limit 1');
assert.ok(Array.isArray(sample.themes) && sample.themes.length, 'themes are an array');
assert.ok(Array.isArray(sample.steps) && sample.steps[0].canonical, 'steps kept');

// The next puzzle: around the player's rating (1500), in the theme, in the range.
const p1 = await call('puzzle_next', { p_token: A });
assert.ok(p1 && p1.id && p1.position && p1.steps, 'a puzzle');
assert.ok(Math.abs(p1.rating - 1500) < 200, `near 1500: ${p1.rating}`);
const easy = await call('puzzle_next', { p_token: A, p_offset: -600 });
assert.ok(easy.rating < 1100, `easiest is easy: ${easy.rating}`);
const mate = await call('puzzle_next', { p_token: A, p_theme: 'mateIn2', p_skip: [p1.id, easy.id] });
assert.ok(mate.themes.includes('mateIn2'));
const ranged = await call('puzzle_next', { p_token: A, p_min: 2000, p_max: 2200 });
assert.ok(ranged.rating >= 2000 && ranged.rating <= 2200, `in range: ${ranged.rating}`);
assert.equal(await call('puzzle_next', { p_token: A, p_min: 5000, p_max: 6000 }), null, 'none in an empty range');
const skipped = await call('puzzle_next', { p_token: A, p_theme: 'mateIn1' });
const mate1 = (await q(`select id from public.puzzles where themes @> '{mateIn1}'`)).map((r) => r.id);
const all1 = mate1.length;
assert.ok(all1 > 0, 'mateIn1 puzzles');

// A rated win moves both ratings once; a second round changes nothing.
const r1 = await call('puzzle_round', { p_token: A, p_id: p1.id, p_win: true, p_rated: true });
assert.ok(r1.first && r1.diff > 0 && r1.rating > 1500, JSON.stringify(r1));
assert.ok(r1.puzzle_rating < p1.rating, 'the puzzle loses rating');
const r2 = await call('puzzle_round', { p_token: A, p_id: p1.id, p_win: false, p_rated: true });
assert.ok(!r2.first && r2.diff === null && r2.rating === r1.rating, JSON.stringify(r2));
// A loss lowers it; an unrated round is kept but changes nothing.
const r3 = await call('puzzle_round', { p_token: A, p_id: easy.id, p_win: false, p_rated: true });
assert.ok(r3.diff < 0, JSON.stringify(r3));
const r4 = await call('puzzle_round', { p_token: A, p_id: mate.id, p_win: true, p_rated: false });
assert.ok(r4.first && r4.diff === null && r4.rating === r3.rating, JSON.stringify(r4));

// Played puzzles are not given again (unless replaying), and get says it was played.
// (Some of them may be the puzzles played above: those are not given again.)
const played = new Set([p1.id, easy.id, mate.id]);
const rated = new Set([p1.id, easy.id]);
for (let p; (p = await call('puzzle_next', { p_token: A, p_theme: 'mateIn1' }));) {
  assert.ok(!played.has(p.id), 'a played puzzle is not given again');
  played.add(p.id);
  rated.add(p.id);
  await call('puzzle_round', { p_token: A, p_id: p.id, p_win: true, p_rated: true });
}
assert.ok(mate1.every((id) => played.has(id)));
assert.equal(await call('puzzle_next', { p_token: A, p_theme: 'mateIn1' }), null, 'all mateIn1 played');
assert.ok(await call('puzzle_next', { p_token: A, p_theme: 'mateIn1', p_replay: true }), 'replay gives one');
const again = await call('puzzle_next', { p_token: A, p_skip: [skipped.id] });
assert.notEqual(again.id, skipped.id);
const got = await call('puzzle_get', { p_token: A, p_id: p1.id });
assert.ok(got.played && got.won === true);
assert.equal(await call('puzzle_get', { p_token: A, p_id: 'nope' }), null);

// The dashboard.
const d = await call('puzzle_dashboard', { p_token: A });
assert.equal(d.total, total);
assert.equal(d.played, played.size);
assert.equal(d.rated, rated.size);
const m1 = d.themes.find((t) => t.theme === 'mateIn1');
assert.equal(m1.total, all1);
assert.equal(m1.played, all1);
assert.equal(m1.left, 0);
assert.equal(d.recent.length, played.size);
const dr = await call('puzzle_dashboard', { p_token: A, p_min: 1000, p_max: 1200 });
assert.ok(dr.themes.every((t) => t.in_range <= t.total));
assert.ok(dr.left < d.left);

// Anonymous players cannot write the tables.
await db.exec('set role anon');
await assert.rejects(db.exec(`update public.puzzles set rating = 0`));
await assert.rejects(db.exec(`select * from private.puzzle_rounds`));
await db.exec('reset role');
console.log(`puzzles-sql: ok (${total} puzzles)`);
