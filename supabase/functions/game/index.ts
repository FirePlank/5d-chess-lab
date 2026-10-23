// The `game` edge function: what needs the rules core. It checks a new seek's or game's start
// position and time control (and writes the start's 5dpgn headers for the record), and checks
// every action against the Kairos rules before the database applies it (game_apply_move: the
// clocks, the result). Everything else a page does goes to the database functions directly.
//
// POST {action: 'create_seek', token, tab, private, variant, base_ms, inc_ms, delay_ms, tl_delay_ms, color}
// POST {action: 'create_engine_game', token, tab, variant, base_ms, inc_ms, delay_ms, tl_delay_ms, color, level, version, book}
// POST {action: 'move', token, tab, id, ply, lan}
// `variant` is a built-in variant's name or a 5DUCI position.
import { call, playAction, rules, startOf } from '../_shared/rules.ts';

type Json = Record<string, any>;

/** The database calls this function makes (PostgREST with the service role; a test double in tests). */
export interface Db {
  game(id: string): Promise<Json | null>;
  rpc(fn: string, args: Json): Promise<Json>;
}

export class UserError extends Error {}

/** A player's id: the SHA-256 of their token, in hex (as the database computes it). */
async function playerId(token: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MINUTES = [...Array(20).keys()].map((i) => i + 1).concat([25, 30, 35, 40, 45, 60]);
const INCREMENTS = [...Array(21).keys()].concat([25, 30, 35, 40, 45, 60]);
const DELAYS = [...Array(11).keys()].concat([15, 20, 30]);
const TL_DELAYS = [...Array(11).keys()];

/** A time control in ms, checked against the choices the site offers (base null: untimed). */
export function timeControl(b: Json) {
  if (b.base_ms == null) return { base_ms: null, inc_ms: 0, delay_ms: 0, tl_delay_ms: 0 };
  const sec = (v: unknown) => Number(v ?? 0) / 1000;
  const base = sec(b.base_ms) / 60, inc = sec(b.inc_ms), delay = sec(b.delay_ms), tl = sec(b.tl_delay_ms);
  if (!MINUTES.includes(base) || !INCREMENTS.includes(inc) || !DELAYS.includes(delay) || !TL_DELAYS.includes(tl)) {
    throw new UserError('That time control is not offered.');
  }
  return { base_ms: base * 60000, inc_ms: inc * 1000, delay_ms: delay * 1000, tl_delay_ms: tl * 1000 };
}

/** The start position (a built-in variant's name or a 5DUCI position), checked, with its record headers. */
async function start(variant: unknown) {
  if (typeof variant !== 'string' || !variant.trim() || variant.length > 2500) throw new UserError('Choose a variant.');
  const k = await rules();
  let s;
  try {
    s = startOf(k, variant.trim());
  } catch (e) {
    throw new UserError('That position cannot be played: ' + (e as Error).message);
  }
  const setup = String(call(k, { cmd: 'export', headers: [] }).pgn).trimEnd();
  return { ...s, setup };
}

function color(v: unknown) {
  if (v == null) return null;
  if (v !== 1 && v !== 2) throw new UserError('Choose a side.');
  return v;
}

function str(v: unknown, what: string, max = 128) {
  if (typeof v !== 'string' || !v || v.length > max) throw new UserError(`Missing ${what}.`);
  return v;
}

export async function handle(body: Json, db: Db): Promise<Json> {
  const token = str(body.token, 'player token');
  const tab = str(body.tab, 'tab', 16);
  switch (body.action) {
    case 'create_seek': {
      const s = await start(body.variant);
      const tc = timeControl(body);
      return db.rpc('seek_create', {
        p_token: token, p_tab: tab, p_private: !!body.private, p_variant: s.variant, p_position: s.position,
        p_setup: s.setup, p_start_to_move: s.toMove === 'w' ? 1 : 2, p_start_active: s.active,
        p_base_ms: tc.base_ms, p_inc_ms: tc.inc_ms, p_delay_ms: tc.delay_ms, p_tl_delay_ms: tc.tl_delay_ms,
        p_color: color(body.color),
      });
    }
    case 'create_engine_game': {
      const s = await start(body.variant);
      const tc = timeControl(body);
      const level = Number(body.level);
      if (!Number.isInteger(level) || level < 1 || level > 8) throw new UserError('Choose a strength from 1 to 8.');
      return db.rpc('engine_game_create', {
        p_token: token, p_tab: tab, p_variant: s.variant, p_position: s.position, p_setup: s.setup,
        p_start_to_move: s.toMove === 'w' ? 1 : 2, p_start_active: s.active,
        p_base_ms: tc.base_ms, p_inc_ms: tc.inc_ms, p_delay_ms: tc.delay_ms, p_tl_delay_ms: tc.tl_delay_ms,
        p_color: color(body.color), p_level: level, p_version: String(body.version ?? 'unknown').slice(0, 40),
        p_book: body.book !== false,
      });
    }
    case 'move': {
      const id = str(body.id, 'game id', 16);
      const lan = str(body.lan, 'action', 4000);
      const g = await db.game(id);
      if (!g) return { error: 'gone' };
      if (g.result) return { error: 'over' };
      // Out of turn or out of date: the page resyncs from the game as it is. (Against Kairos the
      // player's page sends both sides' actions.)
      const p = await playerId(token);
      const side = g.white === p ? 1 : g.black === p ? 2 : 0;
      if (!side) return { error: 'not a player' };
      if (body.ply !== g.ply || (g.engine_color == null && side !== g.to_move)) return { error: 'resync' };
      const k = await rules();
      let played;
      try {
        played = playAction(k, g.position, (g.moves as Json[]).map((m) => m.lan), lan);
      } catch (e) {
        return { error: 'illegal', message: (e as Error).message };
      }
      return db.rpc('game_apply_move', {
        p_token: token, p_tab: tab, p_id: id, p_ply: g.ply, p_lan: played.lan, p_san: played.san, p_full: played.sanFull,
        p_lone: played.lone, p_next_to_move: played.toMove === 'w' ? 1 : 2, p_active: played.active, p_status: played.status,
      });
    }
  }
  throw new UserError('Unknown action.');
}

/** The production database: PostgREST with the service role key the platform provides. */
function postgrest(): Db {
  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    async game(id) {
      const r = await fetch(`${url}/rest/v1/live_games?id=eq.${encodeURIComponent(id)}&select=id,position,moves,ply,result,white,black,engine_color,to_move`, { headers });
      if (!r.ok) throw new Error(`live_games: HTTP ${r.status}`);
      return (await r.json())[0] ?? null;
    },
    async rpc(fn, args) {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
      const text = await r.text();
      const j = text ? JSON.parse(text) : null;
      if (!r.ok) {
        // A function's own refusal (raise ... errcode P0001) is the player's to read.
        if (j && j.code === 'P0001') throw new UserError(j.message);
        throw new Error(`${fn}: HTTP ${r.status} ${text.slice(0, 300)}`);
      }
      return j;
    },
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // The site is cross-origin isolated (its engine threads share memory): its fetches need CORP.
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

if (import.meta.main) {
  const db = postgrest();
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: CORS });
    let body: Json;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'bad request' }, { status: 400, headers: CORS });
    }
    try {
      return Response.json(await handle(body, db), { headers: CORS });
    } catch (e) {
      if (e instanceof UserError) return Response.json({ error: 'refused', message: e.message }, { status: 400, headers: CORS });
      console.error(e);
      return Response.json({ error: 'server', message: 'A server error occurred. Please try again.', detail: String((e as Error).message ?? e).slice(0, 300) }, { status: 500, headers: CORS });
    }
  });
}
