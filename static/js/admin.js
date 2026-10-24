// Fair play for admins (#/admin, #/admin/<case id>): the cases the detector opened
// (scripts/fairplay/detect.mjs) and each one's review, after lichess's mod view: the player, why
// the case opened, every game that counted with its betting score, the player's most telling
// actions in it (how hard the position was, what they played, how long they took and what their
// page saw meanwhile), and the decision: dismiss (the player is cleared and the evidence so far
// stops counting) or ban (barred from rated games). Nothing here is shown to anyone else: the
// database answers admins only.
import { query, report } from './net.js';
import { account, profileHref, ratingText } from './account.js';
import { CASE_LOG_SCORE, gameLogRatios, bestRunLogScore, moveScore, withSignals, awayStats, timingStats } from './fairplay-score.js';
import { tcLabel } from './tc.js';
import { $, $$, el, toast, confirmDialog } from './util.js';

const REASONS = {
  moves: 'Actions match the engine',
  'engine-tab': 'Analysis board in another tab showed the live game',
  'analysis-match': 'An analysis board of theirs (another window or device) showed the live game',
  away: 'Engine matches on turns away from the game',
  timing: 'Think times as even as a program’s',
};
const STATUS = { open: 'Open', dismissed: 'Dismissed', banned: 'Banned' };
/** The actions shown per game, most telling first. */
const TOP_ACTIONS = 8;

/** A log score as the likelihood ratio it stands for: "×1.2e5". */
function ratio(log) {
  if (log == null) return '—';
  const r = Math.exp(log);
  return r < 1000 ? `×${r.toFixed(r < 10 ? 1 : 0)}` : `×${r.toExponential(1).replace('e+', 'e')}`;
}

function seconds(ms) {
  if (ms == null || !Number.isFinite(+ms)) return '—';
  return ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** Each action's think time from the clocks: the mover's clock before it, less after (plus the increment). */
function thinkTimes(game) {
  const out = [];
  const last = [game.base_ms, game.base_ms];
  game.moves.forEach((m, ply) => {
    const side = ply % 2;
    if (m.clk == null) { out.push(null); return; }
    out.push(Math.max(0, last[side] + (game.inc_ms || 0) - m.clk));
    last[side] = m.clk;
  });
  return out;
}

export class AdminPage {
  constructor(app) {
    this.app = app;
    this.status = 'open';
    this.caseId = null;
    $$('#ad-tabs button').forEach((b) => (b.onclick = () => { this.status = b.dataset.status; this.loadList(); }));
    $('#ad-list-body').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) location.hash = `#/admin/${tr.dataset.id}`;
    });
    $('#ad-dismiss').onclick = () => this.decide('dismiss');
    $('#ad-ban').onclick = () => this.decide('ban');
    account.onChange(() => { if (this.app.route === 'admin') this.show(); });
  }

  activate(params) {
    this.caseId = params && params.get('case');
    this.show();
  }

  show() {
    const admin = account.profile && account.profile.admin;
    $('#ad-denied').classList.toggle('hidden', !account.ready || !!admin);
    $('#ad-list').classList.toggle('hidden', !admin || !!this.caseId);
    $('#ad-case').classList.toggle('hidden', !admin || !this.caseId);
    if (!admin) return;
    if (this.caseId) this.loadCase();
    else this.loadList();
  }

  async loadList() {
    $$('#ad-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.status === this.status));
    let rows;
    try {
      rows = await query('fairplay_cases', { p_status: this.status === 'all' ? null : this.status });
    } catch (e) {
      report(e);
      return;
    }
    $('#ad-list-body').replaceChildren(...rows.map((c) => el('tr', { dataset: { id: c.id }, title: 'Review the case' },
      el('td', { text: new Date(c.opened_at).toLocaleString() }),
      el('td', {}, el('a', { href: profileHref(c.user_id), text: c.name })),
      el('td', { class: 'num', text: String(c.rating ?? '') }),
      el('td', { class: 'num', text: String(c.games) }),
      el('td', { text: REASONS[c.reason] || c.reason }),
      el('td', { class: 'num', text: ratio(c.score) }),
      el('td', { class: `ad-status ${c.status}`, text: STATUS[c.status] || c.status }))));
    $('#ad-list-empty').classList.toggle('hidden', rows.length > 0);
    refreshAdminBadge();
  }

  async loadCase() {
    const id = this.caseId;
    let v;
    try {
      v = await query('fairplay_case', { p_case: +id });
    } catch (e) {
      report(e);
      return;
    }
    if (id !== this.caseId) return;
    if (!v) {
      $('#ad-case-head').replaceChildren(el('p', { class: 'muted', text: 'No such case.' }));
      $('#ad-games').replaceChildren();
      $('#ad-decide').classList.add('hidden');
      return;
    }
    this.view = v;
    const c = v.case, p = v.profile;
    // The score now, from the games shown (as the detector computes it).
    const games = v.games.filter((g) => g.outcome === 'analysed');
    const logs = games.map((g) => gameLogRatios(g.evidence || [], g.rating ?? 1500, g.rd ?? 350));
    const now = logs.length ? bestRunLogScore(logs) : null;
    // The page's signals over the same games (as the detector reads them).
    const all = games.flatMap((g) => withSignals(g.evidence || [], g.signals));
    const away = awayStats(all), timing = timingStats(all);
    const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
    $('#ad-case-head').replaceChildren(
      el('div', { class: 'ad-who' },
        el('h1', {}, el('a', { href: profileHref(p.user_id), text: p.name })),
        el('span', { class: 'muted', text: `${ratingText(p.rating, p.provisional)} ± ${p.rd} · ${p.games} rated games${p.banned ? ' · banned' : ''}` })),
      el('dl', { class: 'ad-facts' },
        el('dt', { text: 'Reason' }), el('dd', { text: REASONS[c.reason] || c.reason }),
        el('dt', { text: 'Opened' }), el('dd', { text: new Date(c.opened_at).toLocaleString() }),
        el('dt', { text: 'Score' }), el('dd', { text: c.score != null ? `${ratio(c.score)} (case line ${ratio(CASE_LOG_SCORE)})` : '—' }),
        el('dt', { text: 'Score now' }), el('dd', { text: ratio(now) }),
        el('dt', { text: 'Away turns' }), el('dd', { text: away.away + away.present
          ? `${away.away} of ${away.away + away.present} · engine's first choice ${pct(away.topAway)} away, ${pct(away.topPresent)} on the page${away.z != null ? ` (z ${away.z.toFixed(1)})` : ''}`
          : 'not measured' }),
        el('dt', { text: 'Think times' }), el('dd', { text: timing.mean != null
          ? `${seconds(timing.mean)} on average, variation ${timing.cv.toFixed(2)} (${timing.actions} turns)` : 'not measured' }),
        el('dt', { text: 'Status' }), el('dd', { class: `ad-status ${c.status}`,
          text: (STATUS[c.status] || c.status) + (c.decided_at ? ` · ${new Date(c.decided_at).toLocaleString()}` : '') + (c.note ? ` · ${c.note}` : '') })));
    $('#ad-decide').classList.toggle('hidden', c.status !== 'open');
    $('#ad-note').value = '';
    const flagged = new Set(['engine-tab', 'analysis-match'].includes(c.reason) && c.detail ? [c.detail.game_id] : []);
    $('#ad-games').replaceChildren(...(v.games.length
      ? v.games.map((g) => this.gameCard(g, flagged.has(g.game_id)))
      : [el('p', { class: 'muted', text: 'No assessed games.' })]));
  }

  gameCard(g, flagged) {
    const ev = g.evidence || [];
    const rating = g.rating ?? 1500, rd = g.rd ?? 350;
    const counts = { top: 0, good: 0, miss: 0 };
    for (const e of ev) counts[e.outcome]++;
    const log = ev.length ? Math.max(...gameLogRatios(ev, rating, rd)) : null;
    const think = thinkTimes(g);
    const sig = g.signals || {};
    const tabPlies = Object.entries(sig).filter(([, s]) => s && s.engine_tab).map(([ply]) => +ply);
    const device = new Map((g.matches || []).map((m) => [m.ply, m.via]));
    const devicePlies = new Set(device.keys());
    const scored = ev.map((e) => ({ ...e, score: moveScore(e, rating, rd) })).sort((a, b) => b.score - a.score).slice(0, TOP_ACTIONS);
    const tc = { base_ms: g.base_ms, inc_ms: g.inc_ms, delay_ms: 0, tl_delay_ms: g.tl_delay_ms };
    const outcome = g.result === '1/2-1/2' ? 'Draw' : (g.result === '1-0') === (g.color === 1) ? 'Win' : 'Loss';
    const row = (e) => {
      const s = sig[e.ply] || {};
      const d = e.difficulty || {};
      const hard = [d.goodMoves === 1 ? 'only good action' : `${d.goodMoves} good`, d.deepFind ? 'deep find' : null,
        d.shallowFinds ? null : 'not shallow', d.inCheck ? 'in check' : null, d.bestCaptures ? 'capture' : null,
        d.bestTravels ? 'travel' : null].filter(Boolean).join(', ');
      const page = [s.hidden_ms ? `hidden ${seconds(s.hidden_ms)} (${s.hides || 1}×)` : null,
        s.blurred_ms ? `unfocused ${seconds(s.blurred_ms)}` : null, s.engine_tab ? 'analysis board showed it' : null,
        device.has(e.ply) ? `their analysis board showed it (${device.get(e.ply) === 'account' ? 'their account' : 'their browser'})` : null,
        s.engine_paused ? 'engine tried' : null, s.unmeasured ? 'unmeasured' : null].filter(Boolean).join(', ');
      return el('tr', { class: s.engine_tab || devicePlies.has(e.ply) ? 'ad-flag' : null },
        el('td', { class: 'num', text: String(Math.floor(e.ply / 2) + 1) }),
        el('td', { class: `ad-out ${e.outcome}`, text: e.outcome }),
        el('td', { class: 'num', text: e.loss ? `${(e.loss * 100).toFixed(1)}%` : '0' }),
        el('td', { text: hard }),
        el('td', { class: 'num', text: seconds(think[e.ply]) }),
        el('td', { class: 'num', text: s.first_input_ms != null ? seconds(s.first_input_ms) : '—' }),
        el('td', { text: page || '—' }),
        el('td', { class: 'num', text: ratio(e.score) }));
    };
    // Think times of all their actions: a cheater's are often flat.
    const mine = think.filter((t, ply) => t != null && ply % 2 === g.color - 1);
    const mean = mine.length ? mine.reduce((a, b) => a + b, 0) / mine.length : null;
    const sd = mine.length > 1 ? Math.sqrt(mine.reduce((a, b) => a + (b - mean) ** 2, 0) / (mine.length - 1)) : null;
    return el('section', { class: `panel ad-game${flagged ? ' flagged' : ''}` },
      el('header', { class: 'ad-game-head' },
        el('a', { href: `#/game/${g.game_id}`, text: new Date(g.ended_at).toLocaleString() }),
        el('span', {}, `${g.color === 1 ? 'White' : 'Black'} vs `,
          g.opponent_id ? el('a', { href: profileHref(g.opponent_id), text: g.opponent || 'Player' }) : g.opponent || 'Player'),
        el('span', { text: `${outcome} · ${Math.round(rating)}${g.diff != null ? ` (${g.diff > 0 ? '+' : ''}${Math.round(g.diff)})` : ''}` }),
        el('span', { class: 'muted', text: `${g.variant.replace(/^Standard - /, '')} · ${tcLabel(tc)}` })),
      g.outcome !== 'analysed'
        ? el('p', { class: 'muted', text: 'The detector could not analyse this game.' })
        : el('p', { class: 'ad-sum' },
          `${counts.top} top · ${counts.good} good · ${counts.miss} miss of ${ev.length} judged actions · game score ${ratio(log)}`,
          mean != null ? ` · think ${seconds(mean)} ± ${seconds(sd)}` : '',
          tabPlies.length ? el('strong', { class: 'ad-warn', text: ` · analysis board in another tab showed the live game at action${tabPlies.length > 1 ? 's' : ''} ${tabPlies.map((p) => Math.floor(p / 2) + 1).join(', ')}` }) : null,
          devicePlies.size ? el('strong', { class: 'ad-warn', text: ` · an analysis board of theirs (another window or device) showed it at action${devicePlies.size > 1 ? 's' : ''} ${[...device].map(([p, via]) => `${Math.floor(p / 2) + 1} (${via})`).join(', ')}` }) : null),
      scored.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'games ad-table' },
        el('thead', {}, el('tr', {}, ...['Action', 'Outcome', 'Loss', 'Position', 'Think', 'First touch', 'Page', 'Score']
          .map((h, i) => el('th', { class: [0, 2, 4, 5, 7].includes(i) ? 'num' : null, text: h })))),
        el('tbody', {}, ...scored.map(row)))) : null);
  }

  async decide(action) {
    const c = this.view && this.view.case;
    if (!c) return;
    const name = this.view.profile.name;
    const ok = await confirmDialog(action === 'ban' ? `Ban ${name}?` : `Dismiss the case against ${name}?`, {
      text: action === 'ban' ? 'They can no longer play rated games. The ban can be lifted from their profile.'
        : 'They are cleared: the evidence so far stops counting toward future cases.',
      ok: action === 'ban' ? 'Ban' : 'Dismiss', danger: action === 'ban' });
    if (!ok) return;
    try {
      await query('fairplay_decide', { p_case: c.id, p_action: action, p_note: $('#ad-note').value.trim() || null });
    } catch (e) {
      report(e);
      return;
    }
    toast(action === 'ban' ? `${name} is banned from rated games.` : 'Case dismissed.');
    this.loadCase();
    refreshAdminBadge();
  }
}

/** The header's fair-play link for admins, with the number of open cases. */
export async function refreshAdminBadge() {
  const link = $('#btn-admin');
  const admin = account.profile && account.profile.admin;
  link.classList.toggle('hidden', !admin);
  if (!admin) return;
  let s = null;
  try { s = await query('admin_status'); } catch (e) { /* keep the old count */ return; }
  const n = s ? s.open_cases : 0;
  $('#btn-admin-count').textContent = n ? String(n) : '';
  $('#btn-admin-count').classList.toggle('hidden', !n);
  link.title = n ? `Fair play: ${n} open case${n === 1 ? '' : 's'}` : 'Fair play: no open cases';
}

/** Admins' controls on a profile page: make or unmake an admin, ban or lift a ban. */
export function profileControls(p, reload) {
  if (!(account.profile && account.profile.admin) || !p) return null;
  const act = async (fn, args, msg) => {
    try { await query(fn, { p_user: p.user_id, ...args }); } catch (e) { report(e); return; }
    toast(msg);
    reload();
  };
  return el('div', { class: 'pl-admin' },
    el('button', { type: 'button', class: 'btn sm', text: p.admin ? 'Remove admin' : 'Make admin',
      onclick: async () => {
        if (await confirmDialog(p.admin ? `Remove ${p.name} as an admin?` : `Make ${p.name} an admin?`, { ok: p.admin ? 'Remove' : 'Make admin' })) {
          act('admin_set', { p_admin: !p.admin }, p.admin ? `${p.name} is no longer an admin.` : `${p.name} is an admin.`);
        }
      } }),
    el('button', { type: 'button', class: `btn sm${p.banned ? '' : ' danger'}`, text: p.banned ? 'Lift ban' : 'Ban',
      onclick: async () => {
        if (await confirmDialog(p.banned ? `Let ${p.name} play rated games again?` : `Ban ${p.name} from rated games?`, { ok: p.banned ? 'Lift ban' : 'Ban', danger: !p.banned })) {
          act('admin_ban', { p_banned: !p.banned }, p.banned ? `${p.name} can play rated games again.` : `${p.name} is banned from rated games.`);
        }
      } }));
}
