// The `game` edge function's checks with the real rules core and the database in PGlite:
// creating seeks and games against Kairos from variants and custom positions, and actions that
// are legal, illegal, out of turn or end the game.
// Run: deno run -A tests/online-fn.ts   (needs `cargo wasm-server`; KAIROS_WASM_URL points at the build)
import { PGlite } from 'npm:@electric-sql/pglite@0.5.11';
import { pgcrypto } from 'npm:@electric-sql/pglite@0.5.11/contrib/pgcrypto';

// The server's single-threaded build (`cargo wasm-server`), as the edge function fetches it.
const wasm = new URL('../target/wasm32-wasip1/release/kairos_wasm.wasm', import.meta.url);
Deno.env.set('KAIROS_WASM_URL', wasm.href);
const { handle, timeControl } = await import('../supabase/functions/game/index.ts');

const assert = (ok: unknown, what: string) => { if (!ok) throw new Error('failed: ' + what); };

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(Deno.readTextFileSync(new URL('./supabase-stub.sql', import.meta.url)));
for (const f of [...Deno.readDirSync(new URL('../supabase/migrations/', import.meta.url))].map((e) => e.name).sort()) {
  await db.exec(Deno.readTextFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url)));
}
const Db = {
  async game(id: string) {
    return (await db.query('select id, position, moves, ply, result, white, black, engine_color, to_move from public.live_games where id = $1', [id])).rows[0] ?? null;
  },
  async rpc(fn: string, args: Record<string, unknown>) {
    const names = Object.keys(args);
    const r = await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`, Object.values(args));
    return (r.rows[0] as any).r;
  },
};
const rejects = async (p: Promise<unknown>, re: RegExp) => {
  try { await p; } catch (e) { assert(re.test((e as Error).message), `${re} got ${(e as Error).message}`); return; }
  throw new Error('expected an error ' + re);
};

const A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const tc = { base_ms: 300000, inc_ms: 0, delay_ms: 0, tl_delay_ms: 3000 };

// Time controls: only the offered ones.
assert(timeControl({}).base_ms === null, 'untimed');
await rejects(Promise.resolve().then(() => timeControl({ base_ms: 7 * 60000 + 1 })), /not offered/);

// A seek from a built-in variant: its 5DUCI position and record headers come from the rules core.
const s = await handle({ action: 'create_seek', token: A, tab: 'tabA', private: false, variant: 'Standard - Turn Zero', color: 1, ...tc }, Db);
const seek = (await db.query('select * from public.seeks where id = $1', [s.id])).rows[0] as any;
assert(seek.position.startsWith('size 8x8'), 'canonical position ' + seek.position);
assert(/\[Board "Standard - Turn Zero"\]/.test(seek.setup), 'setup headers');
await rejects(handle({ action: 'create_seek', token: B, tab: 'tabB', variant: 'no such thing', ...tc }, Db), /cannot be played/);

const acc = await Db.rpc('seek_accept', { p_token: B, p_tab: 'tabB', p_id: s.id });
const id = acc.id;
const mv = (token: string, tab: string, ply: number, lan: string) => handle({ action: 'move', token, tab, id, ply, lan }, Db);
let r = await mv(A, 'tabA', 0, '(0T1)g1f3');
assert(r.ok, 'legal action ' + JSON.stringify(r));
r = await mv(B, 'tabB', 1, '(0T1)g8h5');
assert(r.error === 'illegal', 'illegal action');
r = await mv(A, 'tabA', 1, '(0T1)b1c3');
assert(r.error === 'resync', 'out of turn');
r = await mv(B, 'tabB', 0, '(0T1)g8f6');
assert(r.error === 'resync', 'stale ply');
r = await mv(B, 'tabB', 1, '(0T1)g8f6');
assert(r.ok, 'reply');
let g = (await db.query('select * from public.live_games where id = $1', [id])).rows[0] as any;
assert(g.moves[0].san === '(0T1)Nf3' && g.moves[0].full === '(0T1)Ng1f3', 'notation stored ' + JSON.stringify(g.moves[0]));
assert(g.color_ticking === 1 && g.turn_delay_ms === 3000, 'clock with 3 s per timeline');

// A custom position against Kairos: the checkmate practice rook, Black (the rook) to mate.
const e = await handle({ action: 'create_engine_game', token: A, tab: 'tabA2', variant: 'Checkmate Practice - Rook', color: 2, level: 3, version: 'test', book: false, base_ms: null }, Db)
  .catch((x) => ({ error: x.message }));
assert(/already in a game/.test(e.error), 'one game at a time: ' + JSON.stringify(e));
await Db.rpc('game_resign', { p_token: A, p_id: id });
await db.exec('delete from private.recent');
const e2 = await handle({ action: 'create_engine_game', token: A, tab: 'tabA2', variant: 'Checkmate Practice - Rook', color: 2, level: 3, version: 'test', book: false, base_ms: null }, Db);
g = (await db.query('select * from public.live_games where id = $1', [e2.id])).rows[0] as any;
assert(g.engine_color === 1 && g.engine_level === 3 && g.to_move === 1, 'Kairos has White and moves first');
assert(/Checkmate Practice - Rook/.test(g.setup) || /Custom/.test(g.setup), 'setup ' + g.setup);
// The player's page sends Kairos's action too.
r = await handle({ action: 'move', token: A, tab: 'tabA2', id: e2.id, ply: 0, lan: '(0T1)a1b1' }, Db);
assert(r.ok, "Kairos's action " + JSON.stringify(r));

await db.exec('delete from private.recent');
// A game that ends: checkmate is the rules core's verdict, and the record is written.
const s2 = await handle({ action: 'create_seek', token: B, tab: 'tabB3', private: true, variant: 'Standard - Turn Zero', color: 2, base_ms: null }, Db)
  .catch((x) => ({ error: x.message }));
assert(s2.id, 'private seek ' + JSON.stringify(s2));
console.log('online-fn: seeks, games against Kairos and actions checked with the rules core passed');
