// Fair play on this side (after lichess's cevalSub and blur): what the page sees while its
// player has a turn in an online game against a person, sent with the action as its "signals",
// and the engine kept off in this browser's other tabs while such a game is live.
//
// Signals per action: how long the turn took on this page, how long the page was hidden or
// without focus during it (and how often), when the player first touched the board, whether
// another tab of this browser showed the game's live position on the analysis board
// (`engine_tab`), whether another tab tried to run the engine meanwhile (`engine_paused`), and this
// browser's fingerprint (`fp`, below).
// They are kept privately for fair play only (see the Privacy Policy), and can only ever count
// against a player, never for them: a page is the player's to change.
//
// Between tabs (a BroadcastChannel): the game's tab announces its live game every 2 s with its
// position; any other tab's engine refuses to search while an announcement is fresh, and an
// analysis board showing that position says so. Beyond the tab channel (another window or
// device): the analysis board reports what it shows to the server, which matches it against the
// live rated game of the same account or the same browser fingerprint.

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('kairos-fairplay') : null;
// Outside a browser (Node runs the tests), the channel must not keep the process alive.
if (channel && channel.unref) channel.unref();
/** A live-game announcement this old or newer means a game is on in another tab. */
const FRESH_MS = 5000;
/** Positions this early are common to many games: a match there means nothing. */
const MIN_PLY = 6;

let liveElsewhere = null; // {at, key, ply} from another tab
let mine = null; // {id, key, ply, timer} while this tab holds a live game against a person
let turn = null; // the current turn's measurements
let flags = { engine_tab: false, engine_paused: false };

if (channel) {
  channel.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'live') liveElsewhere = { at: Date.now(), key: m.key, ply: m.ply };
    else if (m.type === 'over') liveElsewhere = null;
    else if (mine && m.type === 'match' && m.key === mine.key) flags.engine_tab = true;
    else if (mine && m.type === 'paused') flags.engine_paused = true;
  };
}

/** The boards of a view as one string: the same position gives the same key, however reached. */
export function boardsKey(view) {
  return view.boards.map((b) => b.join(':')).sort().join('|');
}

/** The position's hash as the server keeps it for a live game (supabase/functions/_shared/rules.ts). */
export async function positionKey(view) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(boardsKey(view)));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether this browser has an online game against a person live in another tab. */
export function gameElsewhere() {
  return !!liveElsewhere && Date.now() - liveElsewhere.at < FRESH_MS;
}

/** An engine search was refused here because of that game: its tab hears of it. */
export function enginePaused() {
  if (channel) channel.postMessage({ type: 'paused' });
}

/** The analysis board shows `view`: if it is the live game's position, that game's tab hears of it. */
export function analysing(view) {
  if (!channel || !gameElsewhere() || liveElsewhere.ply < MIN_PLY) return;
  const key = boardsKey(view);
  if (key === liveElsewhere.key) channel.postMessage({ type: 'match', key });
}

// This browser's fingerprint: a hash of what it and its device show every site (its user agent,
// languages, screen, time zone, cores and how it draws text), the same in a private window or
// another profile of the same browser. Sent with each action of an online game, and with what
// the analysis board shows, for fair play only.
let print = null;

/** This browser's fingerprint (32 hex digits), computed once. */
export function browserPrint() {
  if (!print) print = (async () => {
    const parts = [];
    try {
      const n = navigator;
      parts.push(n.userAgent, (n.languages || [n.language]).join(','), n.platform, n.hardwareConcurrency, n.deviceMemory,
        screen.width, screen.height, screen.colorDepth, devicePixelRatio, Intl.DateTimeFormat().resolvedOptions().timeZone);
      const c = document.createElement('canvas');
      c.width = 240;
      c.height = 40;
      const g = c.getContext('2d');
      g.textBaseline = 'top';
      g.font = '16px "Segoe UI", Arial, sans-serif';
      g.fillStyle = '#f60';
      g.fillRect(100, 1, 62, 20);
      g.fillStyle = '#069';
      g.fillText('5D chess ♞ (0T1)Ng1f3 ✓', 2, 15);
      parts.push(c.toDataURL());
    } catch (e) { /* what there is */ }
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
    return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  })();
  return print;
}
let printNow = null;
if (typeof document !== 'undefined') browserPrint().then((p) => (printNow = p), () => {});

// The analysis board, on any device: the hash of what it shows goes to the server (`send`, with
// this browser's fingerprint), which matches it against the live rated game of the signed-in
// account or of the browser with that fingerprint; when there is none, the board stays quiet for
// a minute.
let seen = { key: null, at: 0, quietUntil: 0, timer: null };

/** The analysis board shows `view`. */
export function reportAnalysis(view, send) {
  clearTimeout(seen.timer);
  if (Date.now() < seen.quietUntil) return;
  seen.timer = setTimeout(async () => {
    const key = await positionKey(view);
    if (key === seen.key && Date.now() - seen.at < 30000) return;
    seen.key = key;
    seen.at = Date.now();
    let live = true;
    try { live = await send(key, await browserPrint()); } catch (e) { return; }
    if (!live) seen.quietUntil = Date.now() + 60000;
  }, 1000);
}

/** This tab holds live game `id` against a person, now at `view` after `ply` actions. */
export function gameLive(id, view, ply) {
  const key = boardsKey(view);
  if (!mine || mine.id !== id) {
    gameOver();
    mine = { id, key, ply, timer: setInterval(() => announce(), 2000) };
    flags = { engine_tab: false, engine_paused: false };
  }
  mine.key = key;
  mine.ply = ply;
  announce();
}

function announce() {
  if (channel && mine) channel.postMessage({ type: 'live', key: mine.key, ply: mine.ply });
}

/** The game this tab held is over (or the page left it). */
export function gameOver() {
  if (!mine) return;
  clearInterval(mine.timer);
  mine = null;
  turn = null;
  if (channel) channel.postMessage({ type: 'over' });
}

// ---------------------------------------------------------------- the turn's measurements
const now = () => performance.now();

function hiddenNow() { return typeof document !== 'undefined' && document.visibilityState === 'hidden'; }
function blurredNow() { return typeof document !== 'undefined' && !document.hasFocus(); }

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!turn) return;
    if (hiddenNow()) { turn.hides++; turn.hiddenSince = now(); } else if (turn.hiddenSince != null) { turn.hidden += now() - turn.hiddenSince; turn.hiddenSince = null; }
  });
  addEventListener('blur', () => { if (turn && turn.blurredSince == null) { turn.blurs++; turn.blurredSince = now(); } });
  addEventListener('focus', () => { if (turn && turn.blurredSince != null) { turn.blurred += now() - turn.blurredSince; turn.blurredSince = null; } });
}

/** The player's turn began (or the page opened on it). */
export function turnStarted() {
  turn = { at: now(), hidden: 0, hides: 0, blurred: 0, blurs: 0, first: null,
    hiddenSince: hiddenNow() ? now() : null, blurredSince: blurredNow() ? now() : null };
}

/** The player touched the board (selected a piece or played a move) during their turn. */
export function boardTouched() {
  if (turn && turn.first == null) turn.first = now() - turn.at;
}

/** The signals of the turn now ending (for its action), and a fresh start for the flags. */
export function takeSignals() {
  const t = turn;
  const s = { engine_tab: flags.engine_tab || undefined, engine_paused: flags.engine_paused || undefined, fp: printNow || undefined };
  flags = { engine_tab: false, engine_paused: false };
  turn = null;
  if (!t) return { ...s, unmeasured: true };
  const end = now();
  const hidden = t.hidden + (t.hiddenSince != null ? end - t.hiddenSince : 0);
  const blurred = t.blurred + (t.blurredSince != null ? end - t.blurredSince : 0);
  return { ...s, turn_ms: end - t.at, hidden_ms: hidden, hides: t.hides, blurred_ms: blurred, blurs: t.blurs,
    first_input_ms: t.first == null ? undefined : t.first };
}
