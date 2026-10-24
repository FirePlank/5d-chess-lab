// The Kairos rules core on the server: the site's own core in its single-threaded build
// (kairos-server.wasm: the edge runtime has no shared memory), fetched once per worker from the
// published site (so the server always has the rules the site was built with), behind the same
// JSON calls (`static/js/kairos.js` Rules).
// wasi.js is a copy of static/js/wasi.js (tests/supabase.mjs checks they match).
import { importedMemory, instantiate } from './wasi.js';

const WASM_URL = Deno.env.get('KAIROS_WASM_URL') ?? 'https://fireplank.github.io/5d-chess-lab/kairos-server.wasm';

type Json = Record<string, unknown>;
interface Instance { call(req: Json): Json & { ok: boolean; error?: string } }

let compiled: Promise<{ module: WebAssembly.Module; memory: { initial: number; maximum?: number } | null }> | null = null;
let instance: Instance | null = null;

async function load() {
  if (!compiled) {
    compiled = (async () => {
      const r = await fetch(WASM_URL);
      if (!r.ok) throw new Error(`kairos.wasm: HTTP ${r.status}`);
      const bytes = await r.arrayBuffer();
      return { module: await WebAssembly.compile(bytes), memory: importedMemory(bytes) };
    })();
    compiled.catch(() => { compiled = null; });
  }
  return compiled;
}

/** The rules instance (one game at a time, like the page's). */
export async function rules() {
  if (instance) return instance;
  const { module, memory } = await load();
  // The threads build (a local test may use it) imports shared memory; the server build has its own.
  const mem = memory ? new WebAssembly.Memory({ initial: memory.initial, maximum: memory.maximum, shared: true }) : null;
  instance = await instantiate(module, { memory: mem }) as Instance;
  return instance;
}

/** A call that throws on `ok: false`; a trap drops the instance so the next call starts fresh. */
export function call(k: Instance, req: Json) {
  let r;
  try {
    r = k.call(req);
  } catch (e) {
    instance = null;
    throw new Error('rules core crashed: ' + ((e as Error).message ?? e));
  }
  if (!r.ok) throw new Error(String(r.error));
  return r as Json & { [k: string]: any };
}

export interface Played {
  node: number;
  lan: string;
  san: string;
  sanFull: string;
  lone: boolean;
  /** The side to move after the action ('w'|'b'). */
  toMove: 'w' | 'b';
  /** Timelines active at the start of the next turn (the per-timeline delay counts them). */
  active: number;
  /** checkmate | stalemate | exiled-white | exiled-black | null */
  status: string | null;
  /** The boards after the action (for positionKey). */
  boards: unknown[][];
}

/**
 * Replay `moves` (5DUCI actions) from `start`, then play `lan` for the side to move: what it
 * did, or throws if it is illegal (or the game had ended).
 */
export function playAction(k: Instance, start: string, moves: string[], lan: string): Played {
  call(k, { cmd: 'new', position: start });
  let node = 0;
  if (moves.length) node = call(k, { cmd: 'play_line', node: 0, line: moves.map((m) => m + ' submit').join(' ') }).node;
  if (node !== moves.length) throw new Error('the game could not be replayed');
  const before = call(k, { cmd: 'view', node, draft: [] }).view.status;
  if (before !== 'playing' && before !== 'unknown') throw new Error('the game is over');
  const r = call(k, { cmd: 'play', node, lan });
  const n = r.tree.nodes[r.node];
  const v = call(k, { cmd: 'view', node: r.node, draft: [] }).view;
  const status = ['checkmate', 'stalemate', 'exiled-white', 'exiled-black'].includes(v.status) ? v.status : null;
  return {
    node: r.node, lan: n.lan, san: n.san, sanFull: n.sanFull ?? n.san, lone: !!n.lone,
    toMove: v.player ? 'b' : 'w', active: v.active[1] - v.active[0] + 1, status, boards: v.boards,
  };
}

/**
 * A position's hash for fair play: the SHA-256 of its boards (the same position gives the same
 * hash however it was reached), as static/js/fairplay.js's positionKey computes it on a page
 * (tests/online-fn.ts checks that they agree).
 */
export async function positionKey(boards: unknown[][]) {
  const text = boards.map((b) => b.join(':')).sort().join('|');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A start position for a new game: a built-in variant's name or a 5DUCI position. Returns the
 * position (5DUCI), the variant's name ("Custom" for others), the side to move and the active
 * timelines at the start; throws if it does not load or the game is already over there.
 */
export function startOf(k: Instance, position: string) {
  call(k, { cmd: 'new', position });
  const v = call(k, { cmd: 'view', node: 0, draft: [] }).view;
  if (v.status !== 'playing' && v.status !== 'unknown') throw new Error('the game is already over in this position');
  let variant = 'Custom';
  try { variant = call(k, { cmd: 'variant', position: v.position }).variant; } catch { /* custom */ }
  return { position: v.position as string, variant, toMove: v.player ? 'b' : 'w', active: v.active[1] - v.active[0] + 1 };
}
