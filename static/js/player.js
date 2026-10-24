// A player's profile (#/player/<user id>), after lichess's: name, rating (± deviation, "?" while
// provisional, the peak), results (rated, all games against people, against Kairos and by its
// level), the rating after every rated game as a chart, and the games themselves, newest first,
// against people and against Kairos on separate tabs. Each game opens its game page.
import { query, report } from './net.js';
import { ratingText, profileHref } from './account.js';
import { tcLabel, tcText } from './tc.js';
import { $, $$, el } from './util.js';

const ENDINGS = {
  checkmate: 'Checkmate', exiled: 'Exiled kings', stalemate: 'Stalemate', time: 'Time', resignation: 'Resignation',
  disconnect: 'Abandonment', abandonment: 'Abandonment', agreement: 'Agreement', aborted: 'Aborted',
};
const PAGE = 20;

export class PlayerPage {
  constructor(app) {
    this.app = app;
    this.id = null;
    this.kind = 'people';
    $$('#pl-tabs button').forEach((b) => (b.onclick = () => this.showKind(b.dataset.kind)));
    $('#pl-more').onclick = () => this.loadGames(false);
    $('#pl-body').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) location.hash = `#/game/${tr.dataset.id}`;
    });
  }

  activate(params) {
    const id = params && params.get('id');
    if (id !== this.id) {
      this.id = id;
      this.kind = 'people';
      this.load();
    }
  }

  async load() {
    const id = this.id;
    $('#pl-main').classList.add('hidden');
    $('#pl-missing').classList.add('hidden');
    let p = null;
    try {
      p = /^[0-9a-f-]{36}$/i.test(id || '') ? await query('profile_view', { p_user: id }) : null;
    } catch (e) {
      report(e);
      return;
    }
    if (id !== this.id) return;
    if (!p) {
      $('#pl-missing').classList.remove('hidden');
      return;
    }
    this.p = p;
    this.renderHead(p);
    $('#pl-main').classList.remove('hidden');
    this.showKind(this.kind);
  }

  renderHead(p) {
    $('#pl-name').textContent = p.name;
    const since = new Date(p.created_at);
    $('#pl-since').textContent = `Member since ${since.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`
      + (p.imported ? ' · rating from the 5D rating list' : '');
    $('#pl-rating').textContent = ratingText(p.rating, p.provisional);
    $('#pl-rd').textContent = `± ${p.rd}${p.provisional ? ' · provisional' : ''}`;
    const card = (title, t, extra) => el('div', { class: 'panel pl-stat' },
      el('span', { class: 'pl-stat-k', text: title }),
      el('span', { class: 'pl-stat-v', text: String(t.games) }),
      t.games ? wdl(t) : el('span', { class: 'muted', text: 'No games yet' }),
      extra || null);
    $('#pl-stats').replaceChildren(
      card('Rated games', p.rated, p.peak != null ? el('span', { class: 'muted pl-peak', text: `Peak ${p.peak}` }) : null),
      card('Games against people', p.people),
      card('Games against Kairos', p.kairos));
    $('#pl-chart-box').classList.toggle('hidden', p.history.length < 2);
    if (p.history.length >= 2) $('#pl-chart').replaceChildren(chart(p.history));
  }

  showKind(kind) {
    this.kind = kind;
    $$('#pl-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
    const levels = this.p && this.p.kairos_levels ? Object.entries(this.p.kairos_levels).sort((a, b) => a[0] - b[0]) : [];
    $('#pl-levels').classList.toggle('hidden', kind !== 'kairos' || !levels.length);
    if (kind === 'kairos') {
      $('#pl-levels').replaceChildren(...levels.map(([level, t]) => el('div', { class: 'pl-level' },
        el('strong', { text: +level >= 8 ? 'Full strength' : `Level ${level}` }), wdl(t))));
    }
    this.loadGames(true);
  }

  async loadGames(fresh) {
    const id = this.id, kind = this.kind;
    if (fresh) {
      this.rows = [];
      $('#pl-body').replaceChildren();
    }
    const before = this.rows.length ? this.rows[this.rows.length - 1].ended_at : null;
    let rows;
    try {
      rows = await query('profile_games', { p_user: id, p_kind: kind, p_before: before, p_limit: PAGE });
    } catch (e) {
      report(e);
      return;
    }
    if (id !== this.id || kind !== this.kind) return;
    this.rows.push(...rows);
    $('#pl-body').append(...rows.map((g) => this.row(g)));
    $('#pl-empty').classList.toggle('hidden', this.rows.length > 0);
    $('#pl-more').classList.toggle('hidden', rows.length < PAGE);
  }

  row(g) {
    const tc = { base_ms: g.base_ms, inc_ms: g.inc_ms, delay_ms: g.delay_ms, tl_delay_ms: g.tl_delay_ms };
    const outcome = g.result === '*' ? 'aborted' : g.score === 1 ? 'win' : g.score === 0 ? 'loss' : 'draw';
    const opponent = g.level != null
      ? el('span', { text: g.level >= 8 ? 'Kairos' : `Kairos · Level ${g.level}` })
      : g.opponent_id
        ? el('a', { href: profileHref(g.opponent_id), text: g.opponent || 'Player' })
        : el('span', { class: 'muted', text: g.opponent || 'Anonymous' });
    const side = el('span', { class: `side-dot ${g.color === 1 ? 'white' : 'black'}`, title: g.color === 1 ? 'White' : 'Black' });
    const rating = g.rated
      ? el('span', { class: 'pl-r' }, String(g.rating ?? ''), g.diff != null
        ? el('span', { class: `pl-diff ${g.diff > 0 ? 'up' : g.diff < 0 ? 'down' : ''}`, text: ` ${g.diff > 0 ? '+' : g.diff < 0 ? '−' : '±'}${Math.abs(g.diff)}` })
        : null)
      : el('span', { class: 'muted', text: 'Casual' });
    return el('tr', { dataset: { id: g.id }, title: 'Open the game' },
      el('td', { text: new Date(g.ended_at).toLocaleDateString() }),
      el('td', { class: 'pl-opp' }, side, opponent, g.opponent_rating != null && g.rated ? el('span', { class: 'muted', text: ` (${g.opponent_rating})` }) : null),
      el('td', { class: `center pl-res ${outcome}`, text: { win: 'Win', loss: 'Loss', draw: 'Draw', aborted: 'Aborted' }[outcome] }),
      el('td', {}, rating),
      el('td', { text: ENDINGS[g.termination] || g.termination }),
      el('td', { class: 'num', text: String(g.moves) }),
      el('td', { text: g.variant.replace(/^Standard - /, '') }),
      el('td', { title: tcText(tc), text: tcLabel(tc) }));
  }
}

/** Wins, draws and losses as a bar and counts. */
function wdl(t) {
  const n = Math.max(1, t.wins + t.draws + t.losses);
  const seg = (k, v) => el('span', { class: `pl-bar-${k}`, style: `flex: ${v / n}` });
  return el('div', { class: 'pl-wdl' },
    el('div', { class: 'pl-bar' }, seg('win', t.wins), seg('draw', t.draws), seg('loss', t.losses)),
    el('div', { class: 'pl-counts' },
      el('span', { class: 'win', text: `${t.wins} W` }), el('span', { class: 'draw', text: `${t.draws} D` }), el('span', { class: 'loss', text: `${t.losses} L` })));
}

/** The rating after every rated game ([[ms, rating]], oldest first) as a line chart. */
function chart(history) {
  const W = 640, H = 180, PAD = { l: 44, r: 12, t: 12, b: 24 };
  const xs = history.map((h) => h[0]), ys = history.map((h) => h[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(20, (y1 - y0) * 0.1);
  y0 = Math.floor((y0 - pad) / 50) * 50;
  y1 = Math.ceil((y1 + pad) / 50) * 50;
  const X = (t) => PAD.l + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (r) => PAD.t + (1 - (r - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pl-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Rating over ${history.length} rated games, now ${ys[ys.length - 1]}`);
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    svg.append(e);
    return e;
  };
  const step = (y1 - y0) / 50 > 8 ? 100 : 50;
  for (let r = y0; r <= y1; r += step) {
    add('line', { x1: PAD.l, x2: W - PAD.r, y1: Y(r), y2: Y(r), class: 'pl-grid' });
    add('text', { x: PAD.l - 6, y: Y(r) + 4, 'text-anchor': 'end', class: 'pl-axis' }, String(r));
  }
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  add('text', { x: PAD.l, y: H - 6, class: 'pl-axis' }, fmt(x0));
  add('text', { x: W - PAD.r, y: H - 6, 'text-anchor': 'end', class: 'pl-axis' }, fmt(x1));
  add('polyline', { points: history.map((h) => `${X(h[0])},${Y(h[1])}`).join(' '), class: 'pl-line' });
  for (const [t, r] of history) {
    const dot = add('circle', { cx: X(t), cy: Y(r), r: 3, class: 'pl-dot' });
    const title = document.createElementNS(ns, 'title');
    title.textContent = `${r} · ${new Date(t).toLocaleDateString()}`;
    dot.append(title);
  }
  return svg;
}
