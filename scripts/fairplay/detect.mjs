// The fair-play detector (run by .github/workflows/fairplay.yml when the database has rated
// games waiting): Kairos analyses every position of each rated game between two people (a
// fixed search: single thread, NODES nodes, MULTIPV lines), each player's actions become
// evidence (static/js/fairplay-score.js) with what their page measured, and a player gets a case
// for the admins when their analysis board showed their live rated game, when their page's
// signals break a rule (engine matches on turns away from the page, even think times), or when
// their betting score crosses the case line. Nothing here bans anyone: an admin decides.
//
// SILENT BY DESIGN: the workflow's logs are public, so this prints nothing at all, success or
// failure (it only sets the exit code). Everything it learns goes to the database.
//
// Needs FAIRPLAY_KEY (the detector's key) and the browser core at
// target/wasm32-wasip1-threads/release/kairos_wasm.wasm (the workflow downloads the published one).
import { loadCore } from '../../tests/core.mjs';
import { parseSearch } from './search.mjs';
import { NODES, MULTIPV, CASE_LOG_SCORE, MIN_GAMES, DEVICE_MATCHES, gather, withSignals, signalFindings, gameLogRatios, bestRunLogScore } from '../../static/js/fairplay-score.js';

const URL_ = 'https://iazwinlpwqcdamnybzll.supabase.co';
const PUBLISHABLE = 'sb_publishable_PTo_ji_9zGfGaIK1xKpLUw_fBA_7Jjk';
const KEY = process.env.FAIRPLAY_KEY;
const API = process.env.FAIRPLAY_API || URL_;
/** Stop taking new games after this long (the workflow's own limit is 6 h). */
const BUDGET_MS = 5 * 3600 * 1000;
/** A search stops at this wall time even short of NODES (a safety net, not the normal end). */
const SEARCH_CAP_MS = 12000;

async function rpc(fn, args) {
  let r;
  // A search holds the thread for seconds, long enough for a kept-alive connection to go stale
  // unnoticed: a request that fails on the network is tried again (every call here is safe to repeat).
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetch(`${API}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${PUBLISHABLE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_key: KEY, ...args }),
      });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * attempt));
    }
  }
  if (!r.ok) throw new Error(`${fn}: HTTP ${r.status}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

let infoLines = [];
const core = await loadCore({ onInfo: (l) => infoLines.push(l) });
const call = (req) => {
  const r = core.call(req);
  if (!r.ok) throw new Error(r.error);
  return r;
};
call({ cmd: 'set_hash', mb: 64 });

/** Analyse every position of a game: [{lines, topByDepth, inCheck, forced}] and the actions. */
function analyse(game) {
  const actions = game.moves.map((m) => m.lan);
  call({ cmd: 'new', position: game.position });
  const nodes = [0];
  for (const a of actions) nodes.push(call({ cmd: 'play', node: nodes[nodes.length - 1], lan: a }).node);
  const positions = [];
  for (let k = 0; k <= actions.length; k++) {
    const view = call({ cmd: 'view', node: nodes[k], draft: [] }).view;
    if (view.status && view.status !== 'playing') { positions.push({ failed: true }); continue; }
    const pos = k ? `${game.position} moves ${actions.slice(0, k).map((a) => `${a} submit`).join(' ')}` : game.position;
    infoLines = [];
    try {
      call({ cmd: 'search', position: pos, nodes: NODES, movetime: SEARCH_CAP_MS, multiPV: MULTIPV, skillLevel: 8, book: false, newGame: k === 0 });
    } catch (e) {
      positions.push({ failed: true });
      continue;
    }
    const s = parseSearch(infoLines);
    if (!s || !s.lines.length) { positions.push({ failed: true }); continue; }
    // Board facts: in check, and whether the best action captures or crosses boards.
    const best = s.lines[0];
    try {
      const san = call({ cmd: 'line_san', node: nodes[k], line: best.action + ' submit' }).actions[0];
      best.captures = /x/.test(san ? san.san : '');
    } catch (e) { best.captures = false; }
    // A move to another board is written (l T)sq(l T)sq.
    best.travel = /\)[a-h]\d\(/.test(best.action);
    // One line though MultiPV asked for more: there was only one legal action.
    positions.push({ ...s, inCheck: view.checks.length > 0, forced: s.lines.length === 1 });
  }
  return { positions, actions };
}

async function assessGame(game) {
  let result;
  try {
    result = analyse(game);
  } catch (e) {
    for (const [color, user] of [[1, game.white_user], [2, game.black_user]]) {
      await rpc('fairplay_store', { p_game: game.id, p_user: user, p_color: color, p_outcome: 'failed', p_evidence: null });
    }
    return;
  }
  for (const [color, user] of [[1, game.white_user], [2, game.black_user]]) {
    const evidence = withSignals(gather(result.positions, result.actions, color - 1), game.signals);
    await rpc('fairplay_store', { p_game: game.id, p_user: user, p_color: color, p_outcome: 'analysed', p_evidence: evidence });
    // This browser's analysis board, in another tab, showed the game's live position during it: a
    // case at once. The player's own analysis board on another device (the server's matches):
    // a case from DEVICE_MATCHES turns of one game on (one could be a coincidence).
    const tab = Object.entries(game.signals || {}).filter(([ply, s]) => (+ply % 2) === color - 1 && s && s.engine_tab).map(([ply]) => +ply);
    const device = [...new Set((game.matches || []).filter((m) => m.side === color).map((m) => m.ply))];
    if (tab.length) {
      await openCase({ p_user: user, p_reason: 'engine-tab', p_score: null, p_detail: { game_id: game.id, plies: tab, device } });
    } else if (device.length >= DEVICE_MATCHES) {
      await openCase({ p_user: user, p_reason: 'analysis-match', p_score: null, p_detail: { game_id: game.id, plies: device } });
    }
    await scorePlayer(user);
  }
}

const SITE = 'https://fireplank.github.io/5d-chess-lab/';
const WEBHOOK = process.env.FAIRPLAY_DISCORD_WEBHOOK;
const REASONS = {
  moves: 'Their actions match the engine far more often than the best honest players’ do.',
  'engine-tab': 'Another tab of their browser showed their live rated game on the analysis board.',
  'analysis-match': 'An analysis board of their own (their account, or their browser on another window) showed their live rated game, on several turns.',
  away: 'Their actions match the engine far more often on turns they spent away from the game’s page.',
  timing: 'Their think times are as even as a program’s.',
};

/** Open a case and, when it is new, post it to the admins' Discord channel (FAIRPLAY_DISCORD_WEBHOOK). */
async function openCase(args) {
  const c = await rpc('fairplay_open', args);
  if (!c || !WEBHOOK) return;
  const score = args.p_score == null ? '—' : `×${Math.exp(Math.min(args.p_score, 700)).toExponential(1).replace('e+', 'e')}`;
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: '5D Chess Lab fair play',
        allowed_mentions: { parse: [] },
        embeds: [{
          title: `New fair-play case: ${c.name}`,
          url: `${SITE}#/admin/${c.id}`,
          color: 0xcc3333,
          description: REASONS[args.p_reason] || args.p_reason,
          fields: [
            { name: 'Player', value: `[${c.name}](${SITE}#/player/${c.user_id})`, inline: true },
            { name: 'Rating', value: `${c.rating}${c.provisional ? '?' : ''} · ${c.games} rated games`, inline: true },
            { name: 'Score', value: score, inline: true },
          ],
          footer: { text: `Case ${c.id} · review it on the site` },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) { /* the case is open either way */ }
}

async function scorePlayer(user) {
  const h = await rpc('fairplay_history', { p_user: user });
  if (!h || h.open || h.banned) return;
  // The page's signals: the player against themself, over every counted game.
  const all = h.games.flatMap((g) => g.evidence || []);
  const found = signalFindings(all)[0];
  if (found) {
    await openCase({ p_user: user, p_reason: found.reason, p_score: null,
      p_detail: { ...found.detail, games: h.games.map((g) => g.game_id) } });
    return;
  }
  if (h.games.length < MIN_GAMES) return;
  const games = h.games.map((g) => gameLogRatios(g.evidence || [], g.rating ?? 1500, g.rd ?? 350));
  const score = bestRunLogScore(games);
  if (score >= CASE_LOG_SCORE) {
    await openCase({ p_user: user, p_reason: 'moves', p_score: score,
      p_detail: { games: h.games.map((g, i) => ({ game_id: g.game_id, log: Math.max(...games[i]) })), line: CASE_LOG_SCORE } });
  }
}

try {
  if (!KEY) throw new Error('no key');
  const start = Date.now();
  for (;;) {
    const queue = await rpc('fairplay_queue', { p_limit: 5 });
    if (!queue || !queue.length) break;
    for (const game of queue) {
      if (Date.now() - start > BUDGET_MS) throw new Error('out of time');
      await assessGame(game);
    }
  }
} catch (e) {
  // FAIRPLAY_DEBUG=1 prints the error when run by hand (the workflow never sets it).
  if (process.env.FAIRPLAY_DEBUG) console.error(e);
  process.exitCode = 1;
}
