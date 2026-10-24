// A player's profile (#/player/<user id>), after lichess's: the ratings at the side (rated games,
// puzzles, games against Kairos), the name with whether they are on the site, Challenge (from
// another player) or Edit profile (your own), the rating history over a chosen period, the bio,
// when they joined and were last seen and how long they have played, and then their activity
// (lichess's timeline: each day's games and puzzles) or their games, against people and against
// Kairos. Each game opens its game page. Editing a profile (the name, once a month, and the bio)
// and closing an account are here too.
import { query, report, sb, forgetToken } from './net.js';
import { account, ratingText, profileHref, openSignIn, setProfile } from './account.js';
import { profileControls } from './admin.js';
import { tcLabel, tcText } from './tc.js';
import { $, $$, el, toast } from './util.js';

const ENDINGS = {
  checkmate: 'Checkmate', exiled: 'Exiled kings', stalemate: 'Stalemate', time: 'Time', resignation: 'Resignation',
  disconnect: 'Abandonment', abandonment: 'Abandonment', agreement: 'Agreement', aborted: 'Aborted',
};
const PAGE = 20;
/** The activity shown: this many days back. */
const ACTIVITY_DAYS = 60;
const DAY = 86400000;

function svg(id, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  s.append(use);
  return s;
}

/** "3 hours ago", "yesterday", "2 months ago". */
export function ago(t) {
  const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return 'just now';
  const units = [[60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let n = s / 60;
  for (const [size, name] of units) {
    if (n < size) {
      const k = Math.floor(n);
      return name === 'day' && k === 1 ? 'yesterday' : `${k} ${name}${k === 1 ? '' : 's'} ago`;
    }
    n /= size;
  }
  return '';
}

/** "3 h 12 min", "45 min", "2 days 4 h". */
function duration(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const dateText = (t, o = { year: 'numeric', month: 'long', day: 'numeric' }) => new Date(t).toLocaleDateString(undefined, o);

/** A rating change: "+12", "−8", "±0", coloured. */
function diffEl(d, cls = 'pl-diff') {
  if (d == null) return null;
  const r = Math.round(d);
  return el('span', { class: `${cls} ${r > 0 ? 'up' : r < 0 ? 'down' : ''}`, text: `${r > 0 ? '+' : r < 0 ? '−' : '±'}${Math.abs(r)}` });
}

export class PlayerPage {
  constructor(app) {
    this.app = app;
    this.id = null;
    this.tab = 'activity';
    this.range = 'all';
    $$('#pl-tabs button').forEach((b) => (b.onclick = () => this.showTab(b.dataset.tab)));
    $$('#pl-range button').forEach((b) => (b.onclick = () => { this.range = b.dataset.days; this.renderChart(); }));
    $('#pl-more').onclick = () => this.loadGames(false);
    $('#pl-body').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr[data-id]');
      if (tr) location.hash = `#/game/${tr.dataset.id}`;
    });
    // Your own profile follows your edits; any profile, signing in or out (its buttons).
    account.onChange(() => { if (this.app.route === 'player' && this.p) this.renderHead(this.p); });
    initEditor();
  }

  activate(params) {
    const id = params && params.get('id');
    if (id !== this.id) {
      this.id = id;
      this.tab = 'activity';
      this.range = 'all';
      this.load();
    } else if (this.p) this.loadActivity();
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
      this.p = null;
      $('#pl-missing').classList.remove('hidden');
      return;
    }
    this.p = p;
    this.renderSide(p);
    this.renderHead(p);
    this.renderChart();
    $('#pl-main').classList.remove('hidden');
    this.showTab(this.tab);
  }

  /** The ratings at the side (lichess's sub-ratings). */
  renderSide(p) {
    const row = (iconId, title, value, sub, { href = null, onclick = null, empty = false } = {}) =>
      el(href ? 'a' : 'button', { class: `pl-perf${empty ? ' empty' : ''}`, href, type: href ? null : 'button', onclick },
        svg(iconId, 'pl-perf-icon'),
        el('span', { class: 'pl-perf-text' }, el('h3', { text: title }), el('span', { class: 'pl-perf-v' }, ...value), el('small', { text: sub })),
        svg('i-chevron-right', 'pl-perf-go'));
    const rated = p.rated.games;
    $('#pl-side').replaceChildren(
      row('i-trophy', 'Rated', [el('strong', { text: ratingText(p.rating, p.provisional) }), ' ', diffEl(p.progress, 'pl-progress')],
        `${rated} rated game${rated === 1 ? '' : 's'}${p.peak != null ? ` · peak ${p.peak}` : ''}`,
        { onclick: () => this.showTab('people'), empty: !rated }),
      row('i-puzzle', 'Puzzles', [el('strong', { text: p.puzzles ? ratingText(p.puzzles.rating, p.puzzles.provisional) : '–' })],
        p.puzzles ? `${p.puzzles.played} puzzle${p.puzzles.played === 1 ? '' : 's'}` : 'No puzzles yet',
        { href: account.profile && account.profile.user_id === p.user_id ? '#/puzzles/themes' : null, empty: !p.puzzles }),
      row('i-users', 'Against people', [el('strong', { text: String(p.people.games) })], wdlText(p.people),
        { onclick: () => this.showTab('people'), empty: !p.people.games }),
      row('i-cpu', 'Against Kairos', [el('strong', { text: String(p.kairos.games) })], wdlText(p.kairos),
        { onclick: () => this.showTab('kairos'), empty: !p.kairos.games }));
  }

  /** The name, badges, buttons and the facts under the chart. */
  renderHead(p) {
    const me = account.profile && account.profile.user_id === p.user_id;
    $('#pl-name').textContent = p.name;
    const dot = $('#pl-dot');
    dot.classList.toggle('online', !!p.online);
    dot.title = p.online ? 'Online' : 'Offline';
    $('#pl-badges').replaceChildren(...[
      p.admin && el('span', { class: 'pl-badge admin', text: 'Admin' }),
      p.banned && el('span', { class: 'pl-badge banned', text: 'Barred from rated games', title: 'Banned for fair play' })].filter(Boolean));
    const challenge = el('button', { type: 'button', class: 'btn primary pl-challenge', onclick: () => this.challenge() },
      svg('i-swords'), 'Challenge to a game');
    const edit = el('button', { type: 'button', class: 'btn', onclick: () => openProfileEditor() }, svg('i-edit'), 'Edit profile');
    $('#pl-actions').replaceChildren(...[me ? edit : challenge, me ? null : profileControls(p, () => this.load())].filter(Boolean));
    // The facts.
    const facts = [];
    if (p.bio) facts.push(el('p', { class: 'pl-bio', text: p.bio }));
    const fact = (iconId, text, title) => el('div', { class: 'pl-fact', title }, svg(iconId), el('span', { text }));
    facts.push(el('div', { class: 'pl-facts' },
      fact('i-star', `Member since ${dateText(p.created_at)}`),
      fact('i-eye', p.online ? 'Online now' : p.seen_at ? `Active ${ago(p.seen_at)}` : 'Not seen yet', p.seen_at ? new Date(p.seen_at).toLocaleString() : ''),
      p.play_ms >= 60000 ? fact('i-clock', `Time spent playing: ${duration(p.play_ms)}`) : null,
      p.imported ? fact('i-trophy', 'Rating carried over from the 5D rating list') : null));
    $('#pl-infos').replaceChildren(...facts);
    // A new player's own profile: what to do first, instead of an empty chart.
    const fresh = me && p.history.length < 2;
    $('#pl-new').classList.toggle('hidden', !fresh);
    if (fresh) {
      $('#pl-new').replaceChildren(el('h2', { text: 'Welcome to 5D Chess Lab!' }),
        el('p', { text: 'Your rating history appears here once you have played a couple of rated games.' }),
        el('div', { class: 'pl-new-links' },
          el('a', { class: 'btn primary', href: '#/' }, 'Play a rated game'),
          el('a', { class: 'btn', href: '#/tutorial' }, 'Learn 5D chess'),
          el('a', { class: 'btn', href: '#/puzzles/themes' }, 'Solve puzzles'),
          el('button', { type: 'button', class: 'btn', onclick: () => openProfileEditor() }, 'Write a bio')));
    }
    $('#pl-n-people').textContent = String(p.people.games);
    $('#pl-n-kairos').textContent = String(p.kairos.games);
  }

  challenge() {
    if (!account.profile) {
      toast('Sign in to challenge a player.');
      openSignIn();
      return;
    }
    const home = this.app.pages.home;
    if (!home || !home.setup) return;
    home.setup.open('challenge', { target: { user_id: this.p.user_id, name: this.p.name },
      onCreated: (mode, r) => { if (r && r.id) location.hash = `#/game/${r.id}`; } });
  }

  // ---------------------------------------------------------------- the rating history
  renderChart() {
    const p = this.p;
    const box = $('#pl-chart-box');
    const has = p && p.history.length >= 2;
    box.classList.toggle('hidden', !has);
    if (!has) return;
    $$('#pl-range button').forEach((b) => b.classList.toggle('on', b.dataset.days === this.range));
    const now = Date.now();
    const from = this.range === 'all' ? -Infinity
      : this.range === 'ytd' ? new Date(new Date().getFullYear(), 0, 1).getTime() : now - +this.range * DAY;
    // The rating going into the period, so its line starts at the left edge.
    const before = p.history.filter((h) => h[0] < from);
    let points = p.history.filter((h) => h[0] >= from);
    if (before.length && from > -Infinity) points = [[from, before[before.length - 1][1]], ...points];
    if (points.length < 1) {
      $('#pl-chart').replaceChildren(el('p', { class: 'muted pl-chart-empty', text: 'No rated games in this period.' }));
      return;
    }
    if (points.length === 1) points = [points[0], [now, points[0][1]]];
    $('#pl-chart').replaceChildren(chart(points, this.range === 'all' ? null : [from, now]));
  }

  // ---------------------------------------------------------------- tabs
  showTab(tab) {
    this.tab = tab;
    $$('#pl-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    $('#pl-activity').classList.toggle('hidden', tab !== 'activity');
    $('#pl-games').classList.toggle('hidden', tab === 'activity');
    if (tab === 'activity') this.loadActivity();
    else {
      const levels = this.p && this.p.kairos_levels ? Object.entries(this.p.kairos_levels).sort((a, b) => a[0] - b[0]) : [];
      $('#pl-levels').classList.toggle('hidden', tab !== 'kairos' || !levels.length);
      if (tab === 'kairos') {
        $('#pl-levels').replaceChildren(...levels.map(([level, t]) => el('div', { class: 'pl-level' },
          el('strong', { text: +level >= 8 ? 'Full strength' : `Level ${level}` }), wdl(t))));
      }
      this.loadGames(true);
    }
  }

  async loadActivity() {
    const id = this.id;
    let a;
    try {
      a = await query('profile_activity', { p_user: id, p_days: ACTIVITY_DAYS });
    } catch (e) {
      report(e);
      return;
    }
    if (id !== this.id || !a) return;
    $('#pl-activity').replaceChildren(activity(a, this.p));
  }

  async loadGames(fresh) {
    const id = this.id, kind = this.tab;
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
    if (id !== this.id || kind !== this.tab) return;
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
      ? el('span', { class: 'pl-r' }, String(g.rating ?? ''), g.diff != null ? ' ' : null, diffEl(g.diff))
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

function wdlText(t) {
  return t.games ? `${t.wins} W · ${t.draws} D · ${t.losses} L` : 'No games yet';
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

// ---------------------------------------------------------------- the activity timeline
/** Lichess's score boxes: wins, draws, losses. */
function score(w, d, l) {
  return el('span', { class: 'act-score' },
    w ? el('strong', { class: 'win', title: `${w} won`, text: String(w) }) : null,
    d ? el('strong', { class: 'draw', title: `${d} drawn`, text: String(d) }) : null,
    l ? el('strong', { class: 'loss', title: `${l} lost`, text: String(l) }) : null);
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayTitle(t) {
  const d = new Date(t), today = new Date();
  const y = new Date(today.getTime() - DAY);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(y)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

function activity(a, p) {
  const days = new Map(); // key -> {t, games: [], puzzles: [], signup}
  const day = (t) => {
    const k = dayKey(t);
    if (!days.has(k)) days.set(k, { t: new Date(t).getTime(), games: [], puzzles: [], signup: false });
    return days.get(k);
  };
  for (const g of a.games) day(g.at).games.push(g);
  for (const [t, win, diff] of a.puzzles) day(t).puzzles.push({ win, diff });
  if (Date.now() - new Date(a.created_at).getTime() < ACTIVITY_DAYS * DAY) day(a.created_at).signup = true;
  const list = [...days.values()].sort((x, y) => y.t - x.t);
  if (!list.length) return el('p', { class: 'muted act-none', text: `No activity in the last ${ACTIVITY_DAYS} days.` });
  return el('div', { class: 'act' }, ...list.map((d) => el('section', { class: 'act-day' },
    el('h2', {}, el('time', { datetime: new Date(d.t).toISOString(), text: dayTitle(d.t) })),
    el('div', { class: 'act-entries' }, ...entries(d, p)))));
}

function entries(d, p) {
  const out = [];
  const entry = (iconId, cls, head, sub = null) => el('div', { class: `act-entry ${cls}` },
    el('span', { class: 'act-icon' }, svg(iconId)), el('div', { class: 'act-body' }, el('div', { class: 'act-line' }, ...head), sub));
  const opponents = (games) => {
    const seen = new Map();
    for (const g of games) {
      const key = g.opponent_id || g.opponent || 'Anonymous';
      if (!seen.has(key)) seen.set(key, g);
    }
    const shown = [...seen.values()].slice(0, 6);
    return el('div', { class: 'act-sub' }, 'against ', ...shown.flatMap((g, i) => [i ? ', ' : null,
      g.opponent_id ? el('a', { href: profileHref(g.opponent_id), text: g.opponent }) : el('span', { text: g.opponent || 'Anonymous' })]),
    seen.size > shown.length ? ` and ${seen.size - shown.length} more` : null);
  };
  const tally = (games) => [games.filter((g) => g.score === 1).length, games.filter((g) => g.score === 0.5).length, games.filter((g) => g.score === 0).length];
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const rated = d.games.filter((g) => g.rated && g.level == null);
  if (rated.length) {
    const diff = rated.reduce((s, g) => s + (g.diff || 0), 0);
    const after = rated[0].after;
    out.push(entry('i-trophy', 'rated', [el('span', { text: `Played ${n(rated.length, 'rated game')}` }),
      after != null ? el('span', { class: 'act-rating' }, String(after), ' ', diffEl(diff)) : null, score(...tally(rated))], opponents(rated)));
  }
  const casual = d.games.filter((g) => !g.rated && g.level == null);
  if (casual.length) out.push(entry('i-users', 'casual', [el('span', { text: `Played ${n(casual.length, 'casual game')}` }), score(...tally(casual))], opponents(casual)));
  const kairos = d.games.filter((g) => g.level != null);
  if (kairos.length) {
    const levels = [...new Set(kairos.map((g) => g.level))].sort((x, y) => x - y);
    out.push(entry('i-cpu', 'kairos', [el('span', { text: `Played ${n(kairos.length, 'game')} against Kairos` }), score(...tally(kairos))],
      el('div', { class: 'act-sub', text: levels.map((l) => (l >= 8 ? 'full strength' : `level ${l}`)).join(', ') })));
  }
  if (d.puzzles.length) {
    const won = d.puzzles.filter((x) => x.win).length;
    const diff = d.puzzles.reduce((s, x) => s + (x.diff || 0), 0);
    out.push(entry('i-puzzle', 'puzzles', [el('span', { text: `Solved ${won} of ${n(d.puzzles.length, 'puzzle')}` }),
      d.puzzles.some((x) => x.diff != null) ? el('span', { class: 'act-rating' }, diffEl(diff)) : null,
      score(won, 0, d.puzzles.length - won)]));
  }
  if (d.signup) out.push(entry('i-sparkle', 'signup', [el('span', { text: `Signed up to 5D Chess Lab as ${p.name}` })]));
  return out;
}

// ---------------------------------------------------------------- the chart
/** The rating after every rated game ([[ms, rating]], oldest first) as a line chart with a crosshair. */
function chart(history, span) {
  const W = 720, H = 220, PAD = { l: 46, r: 14, t: 14, b: 26 };
  const xs = history.map((h) => h[0]), ys = history.map((h) => h[1]);
  const x0 = span ? span[0] : Math.min(...xs), x1 = span ? span[1] : Math.max(...xs);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const pad = Math.max(20, (y1 - y0) * 0.12);
  y0 = Math.floor((y0 - pad) / 50) * 50;
  y1 = Math.ceil((y1 + pad) / 50) * 50;
  const X = (t) => PAD.l + (x1 === x0 ? 0.5 : (t - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (r) => PAD.t + (1 - (r - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(ns, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svgEl.setAttribute('class', 'pl-svg');
  svgEl.setAttribute('role', 'img');
  svgEl.setAttribute('aria-label', `Rating over ${history.length} points, now ${ys[ys.length - 1]}`);
  const add = (tag, attrs, text, parent = svgEl) => {
    const e = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    parent.append(e);
    return e;
  };
  const defs = add('defs', {});
  const grad = add('linearGradient', { id: 'pl-fill', x1: 0, y1: 0, x2: 0, y2: 1 }, null, defs);
  add('stop', { offset: '0%', 'stop-color': 'var(--accent)', 'stop-opacity': 0.28 }, null, grad);
  add('stop', { offset: '100%', 'stop-color': 'var(--accent)', 'stop-opacity': 0 }, null, grad);
  const step = (y1 - y0) / 50 > 8 ? 100 : 50;
  for (let r = y0; r <= y1; r += step) {
    add('line', { x1: PAD.l, x2: W - PAD.r, y1: Y(r), y2: Y(r), class: 'pl-grid' });
    add('text', { x: PAD.l - 8, y: Y(r) + 4, 'text-anchor': 'end', class: 'pl-axis' }, String(r));
  }
  // Date ticks: about five across.
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, x1 - x0 > 300 * DAY ? { month: 'short', year: '2-digit' } : { month: 'short', day: 'numeric' });
  for (let i = 0; i <= 4; i++) {
    const t = x0 + ((x1 - x0) * i) / 4;
    add('text', { x: X(t), y: H - 7, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', class: 'pl-axis' }, fmt(t));
  }
  // A step line (a rating holds until the next game), filled below.
  let d = `M${X(history[0][0])},${Y(history[0][1])}`;
  for (let i = 1; i < history.length; i++) d += ` H${X(history[i][0])} V${Y(history[i][1])}`;
  d += ` H${X(x1)}`;
  add('path', { d: `${d} V${H - PAD.b} H${X(history[0][0])} Z`, class: 'pl-area', fill: 'url(#pl-fill)' });
  add('path', { d, class: 'pl-line' });
  if (history.length <= 60) for (const [t, r] of history) add('circle', { cx: X(t), cy: Y(r), r: 2.6, class: 'pl-dot' });
  // The crosshair: the rating at the pointer's date.
  const cross = add('g', { class: 'pl-cross hidden' });
  const vline = add('line', { y1: PAD.t, y2: H - PAD.b, class: 'pl-cross-line' }, null, cross);
  const knob = add('circle', { r: 4.5, class: 'pl-cross-dot' }, null, cross);
  const tipBg = add('rect', { rx: 4, height: 34, class: 'pl-tip-bg' }, null, cross);
  const tip1 = add('text', { class: 'pl-tip-v' }, '', cross);
  const tip2 = add('text', { class: 'pl-tip-d' }, '', cross);
  const hit = add('rect', { x: PAD.l, y: PAD.t, width: W - PAD.l - PAD.r, height: H - PAD.t - PAD.b, fill: 'transparent' });
  const move = (e) => {
    const box = svgEl.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const t = x0 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (x1 - x0);
    let i = 0;
    while (i + 1 < history.length && history[i + 1][0] <= t) i++;
    const [ht, r] = history[i];
    const cx = Math.max(PAD.l, Math.min(W - PAD.r, x));
    vline.setAttribute('x1', cx);
    vline.setAttribute('x2', cx);
    knob.setAttribute('cx', cx);
    knob.setAttribute('cy', Y(r));
    tip1.textContent = String(r);
    tip2.textContent = new Date(Math.max(ht, Math.min(t, x1))).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    const w = 96, left = cx + w + 12 > W ? cx - w - 10 : cx + 10;
    tipBg.setAttribute('x', left);
    tipBg.setAttribute('y', PAD.t + 2);
    tipBg.setAttribute('width', w);
    tip1.setAttribute('x', left + 8);
    tip1.setAttribute('y', PAD.t + 17);
    tip2.setAttribute('x', left + 8);
    tip2.setAttribute('y', PAD.t + 30);
    cross.classList.remove('hidden');
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => cross.classList.add('hidden'));
  return svgEl;
}

// ---------------------------------------------------------------- editing your profile
let editorReady = false;

function initEditor() {
  if (editorReady) return;
  editorReady = true;
  const dlg = $('#dlg-profile');
  $('#pe-cancel').onclick = () => dlg.close();
  $('#pe-bio').oninput = () => { $('#pe-bio-count').textContent = String($('#pe-bio').value.length); };
  $('#pe-close-confirm').oninput = () => {
    $('#pe-close').disabled = !account.profile || $('#pe-close-confirm').value !== account.profile.name;
  };
  $('#pe-form').onsubmit = async (e) => {
    e.preventDefault();
    const p = account.profile;
    if (!p) return;
    const name = $('#pe-name').value.trim(), bio = $('#pe-bio').value;
    const btn = $('#pe-save');
    btn.disabled = true;
    try {
      const updated = await query('account_update', { p_name: name !== p.name ? name : null, p_bio: bio !== (p.bio || '') ? bio : null });
      setProfile(updated);
      dlg.close();
      toast('Profile saved.');
      const page = window.kairosApp && window.kairosApp.pages.player;
      if (page && page.id === p.user_id && window.kairosApp.route === 'player') page.load();
    } catch (err) {
      if (err.user) {
        $('#pe-error').textContent = err.message;
        $('#pe-error').classList.remove('hidden');
      } else report(err);
    } finally {
      btn.disabled = false;
    }
  };
  $('#pe-close').onclick = async () => {
    const p = account.profile;
    if (!p || $('#pe-close-confirm').value !== p.name) return;
    $('#pe-close').disabled = true;
    try {
      await query('account_delete', { p_confirm: p.name });
    } catch (err) {
      $('#pe-close').disabled = false;
      if (err.user) {
        $('#pe-error').textContent = err.message;
        $('#pe-error').classList.remove('hidden');
      } else report(err);
      return;
    }
    // The account is gone: sign out here, as a new guest.
    try { await sb().auth.signOut(); } catch (e2) { /* the session went with the account */ }
    forgetToken();
    location.hash = '#/';
    location.reload();
  };
}

/** Open the edit-profile dialog for the signed-in player. */
export function openProfileEditor() {
  const p = account.profile;
  if (!p) { openSignIn(); return; }
  initEditor();
  $('#pe-name').value = p.name;
  $('#pe-bio').value = p.bio || '';
  $('#pe-bio-count').textContent = String((p.bio || '').length);
  const next = p.renamed_at ? new Date(new Date(p.renamed_at).getTime() + 30 * DAY) : null;
  $('#pe-name-note').textContent = next && next > new Date()
    ? `You can change your name again on ${dateText(next)}.`
    : '3 to 20 letters, digits, _ or -. You can change it once every 30 days; your games show the new name.';
  $('#pe-name').disabled = !!(next && next > new Date());
  $('#pe-error').classList.add('hidden');
  $('#pe-close-name').textContent = p.name;
  $('#pe-close-confirm').value = '';
  $('#pe-close').disabled = true;
  $('.pe-danger').open = false;
  $('#dlg-profile').showModal();
}
