// The connection to the online-play backend (Supabase): who this browser is, calls to the
// database functions and the `game` edge function, live updates (Realtime), the server's clock,
// and the presence pings that let the server tell a player who is here from one who left.
//
// A random token kept in this browser (localStorage) is the player's identity, and the server
// knows it only by its SHA-256 (the player id, `pid`). Signing in (account.js) links the token to
// an account; signing out starts a fresh token. Each tab has its own id (sessionStorage), so the
// server can tell a player's tabs apart.
import { toast } from './util.js';

export const SUPABASE_URL = 'https://iazwinlpwqcdamnybzll.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_PTo_ji_9zGfGaIK1xKpLUw_fBA_7Jjk';

/** Presence pings every this often; the server counts a page gone after 12 s without one. */
const PING_MS = 5000;
/** An action that could not be sent is retried when the connection returns, if this recent. */
const INTENT_LIFETIME_MS = 10000;

function randomString(n, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function loadToken() {
  let t = null;
  try { t = localStorage.getItem('kairos.playerToken'); } catch (e) { /* private mode */ }
  if (!t || !/^[A-Za-z0-9_-]{32,128}$/.test(t)) {
    t = randomString(43, B62 + '-_');
    try { localStorage.setItem('kairos.playerToken', t); } catch (e) { /* one session only */ }
  }
  return t;
}

function loadTab() {
  let t = null;
  try { t = sessionStorage.getItem('kairos.tab'); } catch (e) { /* ignore */ }
  if (!t || !/^[A-Za-z0-9]{8}$/.test(t)) {
    t = randomString(8, B62);
    try { sessionStorage.setItem('kairos.tab', t); } catch (e) { /* ignore */ }
  }
  return t;
}

export const token = loadToken();

/** A fresh token for this browser from the next page load on (after signing out). */
export function forgetToken() {
  try { localStorage.removeItem('kairos.playerToken'); } catch (e) { /* private mode */ }
}
export const tab = loadTab();

/** This player's id (the SHA-256 of the token, in hex), as the server knows it. */
export const pid = (async () => {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
})();

let client = null;
/**
 * The Supabase client (vendor/supabase-*.js), or null where it did not load. Its session (a
 * signed-in account, account.js) persists in this browser; the sign-in redirect comes back with
 * a PKCE code in the query string, which it exchanges on load (the page's own routes live in the
 * hash).
 */
export function sb() {
  if (!client && self.supabase && self.supabase.createClient) {
    client = self.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'kairos.auth' },
    });
  }
  return client;
}

export class ServerError extends Error {
  constructor(message, { user = false, network = false } = {}) {
    super(message);
    this.user = user; // the server refused it, with a reason for the player
    this.network = network; // it never reached the server
  }
}

// ---------------------------------------------------------------- connection state
let online = true;
const connectionListeners = new Set();
/** Listen for the connection going (false) and coming back (true). */
export function onConnection(fn) { connectionListeners.add(fn); return () => connectionListeners.delete(fn); }
export function isOnline() { return online; }
function setOnline(v) {
  if (v === online) return;
  online = v;
  for (const fn of connectionListeners) fn(v);
  if (v) retryHeld();
}
addEventListener('offline', () => setOnline(false));
addEventListener('online', () => { if (navigator.onLine) pingNow(); });

// ---------------------------------------------------------------- the server's clock
// offset = server time - local time, from the ping with the shortest round trip lately.
let offset = 0;
let bestRtt = Infinity;
let bestAt = 0;
/** Now on the server's clock (ms since the epoch). */
export function serverNow() { return Date.now() + offset; }
/** The round trip of the last ping (ms), for display. */
export let lastRtt = null;
function sample(t0, t1, server) {
  const rtt = t1 - t0;
  lastRtt = rtt;
  // Prefer a fast round trip; let an old sample age out after a minute.
  if (rtt <= bestRtt || t1 - bestAt > 60000) {
    bestRtt = rtt;
    bestAt = t1;
    offset = server - (t0 + t1) / 2;
  }
}

// ---------------------------------------------------------------- calls
// Calls that say where this tab is (presence) reach the server in the order they were made: a
// "left the lobby" must never land after the next page's "opened the game".
const ORDERED = new Set(['ping', 'leave', 'game_open', 'challenge_open', 'seek_accept']);
let chain = Promise.resolve();

/** Call a database function with this player's token. Throws ServerError. */
export function rpc(fn, args = {}) {
  if (!ORDERED.has(fn)) return call(fn, args);
  const p = chain.then(() => call(fn, args));
  chain = p.catch(() => {});
  return p;
}

/** Call a database function that reads public data (no player token). Throws ServerError. */
export function query(fn, args = {}) {
  return call(fn, args, false);
}

async function call(fn, args, withToken = true) {
  const c = sb();
  if (!c) throw new ServerError('Online play is not available here.', { network: true });
  let res;
  try {
    res = await c.rpc(fn, withToken ? { p_token: token, ...args } : args);
  } catch (e) {
    setOnline(false);
    throw new ServerError('You are disconnected.', { network: true });
  }
  if (res.error) {
    const e = res.error;
    if (!e.code && /fetch|network|Failed/i.test(e.message || '')) {
      setOnline(false);
      throw new ServerError('You are disconnected.', { network: true });
    }
    throw new ServerError(e.message || 'A server error occurred. Please try again.', { user: e.code === 'P0001' });
  }
  setOnline(true);
  return res.data;
}

/** Call the `game` edge function (moves, new seeks and games). Throws ServerError. */
export async function edge(action, body = {}) {
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/functions/v1/game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      body: JSON.stringify({ action, token, tab, ...body }),
    });
  } catch (e) {
    setOnline(false);
    throw new ServerError('You are disconnected.', { network: true });
  }
  setOnline(true);
  let j = null;
  try { j = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) throw new ServerError((j && j.message) || `A server error occurred (HTTP ${r.status}). Please try again.`, { user: !!(j && j.error === 'refused') });
  return j;
}

// ---------------------------------------------------------------- intents
// A player's action (resign, offer a draw, claim, ...) that could not reach the server is kept
// and sent once the connection returns, if it is still recent and still makes sense; while one
// is on its way, the same action cannot be sent again.
const held = new Map(); // key -> {fn, args, valid, at, resolve, reject}
const outstanding = new Set();

/** Whether `key` is being sent (its button should look busy). */
export function isOutstanding(key) { return outstanding.has(key) || held.has(key); }

export function intent(key, fn, args, valid = () => true) {
  if (outstanding.has(key)) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const send = async (item) => {
      outstanding.add(key);
      try {
        resolve(await rpc(fn, args));
      } catch (e) {
        if (e.network) held.set(key, item);
        else reject(e);
      } finally {
        outstanding.delete(key);
      }
    };
    send({ fn, args, valid, at: Date.now(), send });
  });
}

function retryHeld() {
  for (const [key, item] of [...held]) {
    held.delete(key);
    if (Date.now() - item.at < INTENT_LIFETIME_MS && item.valid()) item.send(item);
  }
}

// ---------------------------------------------------------------- presence
// The page this tab is on, for the server: 'lobby', 'challenge' (ref: its id) or 'game' (ref:
// the game id). Pinged every 5 s while set; cleared (and the server told the page closed on
// purpose) when the tab leaves it.
let page = null;
let ref = null;
let pingTimer = null;
const pingListeners = new Set();
export function onPing(fn) { pingListeners.add(fn); return () => pingListeners.delete(fn); }

async function pingNow() {
  if (!page) {
    // Nothing to report: a light call keeps the clock and the connection state fresh.
    return;
  }
  const t0 = Date.now();
  try {
    const r = await rpc('ping', { p_tab: tab, p_page: page, p_ref: ref });
    sample(t0, Date.now(), r.now);
    for (const fn of pingListeners) fn(r);
  } catch (e) {
    if (!e.network) console.warn('ping:', e.message);
  }
}

/** Tell the server this tab is on `p` (with `r`), from now on, until the next call. */
export function setPresence(p, r = null) {
  if (page === p && ref === r) return;
  // Another page of the site: its first ping takes this tab's place on the server. Only leaving
  // for a page the server need not know about says the tab left.
  if (page && !p) leaveNow();
  page = p;
  ref = r;
  clearInterval(pingTimer);
  pingTimer = null;
  if (!page) return;
  pingNow();
  pingTimer = setInterval(pingNow, PING_MS);
}

/** The page closed on purpose (the server opens the opponent's 10 s claim window at once). */
function leaveNow(keepalive = false) {
  const body = JSON.stringify({ p_token: token, p_tab: tab });
  if (keepalive) {
    // pagehide: the page may be gone before a normal request finishes.
    try {
      fetch(`${SUPABASE_URL}/rest/v1/rpc/leave`, {
        method: 'POST', keepalive: true, body,
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      });
    } catch (e) { /* the tab is closing */ }
  } else {
    rpc('leave', { p_tab: tab }).catch(() => {});
  }
}

addEventListener('pagehide', () => {
  if (page) leaveNow(true);
  clearInterval(pingTimer);
  pingTimer = null;
});
addEventListener('pageshow', (e) => {
  // Back from the back/forward cache: the server thinks this tab left.
  if (e.persisted && page) {
    pingNow();
    clearInterval(pingTimer);
    pingTimer = setInterval(pingNow, PING_MS);
  }
});

/** One-time server clock sample (pages that show clocks call it before the first ping lands). */
export async function syncClock() {
  const t0 = Date.now();
  try {
    const r = await rpc('ping', { p_tab: tab, p_page: page || 'lobby', p_ref: ref });
    sample(t0, Date.now(), r.now);
  } catch (e) { /* the pings will retry */ }
}

// ---------------------------------------------------------------- live updates
/**
 * Subscribe to changes of `table` (optionally `filter`, e.g. "id=eq.abc") and, with `presence`
 * ({key, state}), join the channel's presence. Calls `onChange(payload)` per change, `onSync()`
 * every time the subscription is (re)established (refetch then), `onPresence(state)` on presence
 * changes. Returns an unsubscribe function.
 */
export function live(name, { table, filter, onChange, onSync, presence, onPresence, broadcast } = {}) {
  const c = sb();
  if (!c) return Object.assign(() => {}, { send: () => {} });
  const channel = c.channel(name, presence ? { config: { presence: { key: presence.key } } } : undefined);
  if (table) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, (p) => onChange && onChange(p));
  }
  // Messages between the pages on this channel (not the database's): {event: handler(payload)}.
  for (const [event, fn] of Object.entries(broadcast || {})) channel.on('broadcast', { event }, (m) => fn(m.payload));
  if (presence) {
    channel.on('presence', { event: 'sync' }, () => onPresence && onPresence(channel.presenceState()));
  }
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      setOnline(true);
      if (presence) {
        try { await channel.track(presence.state || {}); } catch (e) { /* presence is a nicety */ }
      }
      if (onSync) onSync();
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      setOnline(false);
    }
  });
  const off = () => { c.removeChannel(channel); };
  /** Broadcast `payload` as `event` to the channel's other pages. */
  off.send = (event, payload) => channel.send({ type: 'broadcast', event, payload }).catch(() => {});
  return off;
}

/** Show a server refusal or failure as a toast. */
export function report(e) {
  if (e && e.network) toast('You are disconnected.', { error: true });
  else toast((e && e.message) || String(e), { error: !(e && e.user) });
}
