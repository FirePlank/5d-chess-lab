// The Community pages (#/players, #/leaderboard), after lichess's player lists: every player (the
// site is small enough to show them all), those on the site now first as cards, then everyone,
// searchable and sorted by when they were last active, rating, games or joining; and the
// leaderboard, the top three on a podium and the rest ranked, with each rating's change over its
// last 12 games. Both refresh every 30 seconds while shown.
import { query, report } from './net.js';
import { account, profileHref, ratingText } from './account.js';
import { ago } from './player.js';
import { $, $$, el } from './util.js';

const REFRESH_MS = 30000;

function svg(id, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  s.append(use);
  return s;
}

function progress(d) {
  if (d == null) return el('span', { class: 'muted', text: '–' });
  const r = Math.round(d);
  return el('span', { class: `pl-progress ${r > 0 ? 'up' : r < 0 ? 'down' : ''}`, text: `${r > 0 ? '▲ ' : r < 0 ? '▼ ' : ''}${Math.abs(r)}` });
}

function nameLink(p, cls = 'cm-name') {
  return el('a', { class: cls, href: profileHref(p.user_id) },
    el('span', { class: `pl-dot${p.online ? ' online' : ''}`, title: p.online ? 'Online' : 'Offline' }),
    el('span', { text: p.name }),
    p.admin ? el('span', { class: 'pl-badge admin sm', text: 'Admin' }) : null,
    account.profile && account.profile.user_id === p.user_id ? el('span', { class: 'cm-you', text: 'you' }) : null);
}

export class CommunityPage {
  constructor(app) {
    this.app = app;
    this.players = [];
    this.sort = 'active';
    this.view = 'players';
    $('#cm-search').oninput = () => this.renderAll();
    $$('#cm-sort button').forEach((b) => (b.onclick = () => { this.sort = b.dataset.sort; this.renderAll(); }));
    for (const body of ['#cm-body', '#cm-ranks']) {
      $(body).addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        const tr = e.target.closest('tr[data-id]');
        if (tr) location.hash = profileHref(tr.dataset.id);
      });
    }
  }

  activate(params) {
    this.view = (params && params.get('view')) === 'leaderboard' ? 'leaderboard' : 'players';
    $('#cm-title').textContent = this.view === 'leaderboard' ? 'Leaderboard' : 'Players';
    $$('.cm-switch a').forEach((a) => a.classList.toggle('on', a.dataset.view === this.view));
    $('#cm-players').classList.toggle('hidden', this.view !== 'players');
    $('#cm-board').classList.toggle('hidden', this.view !== 'leaderboard');
    this.render();
    this.load();
    clearInterval(this.timer);
    this.timer = setInterval(() => { if (document.visibilityState === 'visible') this.load(); }, REFRESH_MS);
  }

  deactivate() { clearInterval(this.timer); }

  async load() {
    try {
      this.players = (await query('community')) || [];
    } catch (e) {
      report(e);
      return;
    }
    this.render();
  }

  render() {
    if (this.view === 'leaderboard') this.renderBoard();
    else { this.renderOnline(); this.renderAll(); }
  }

  renderOnline() {
    const on = this.players.filter((p) => p.online).sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    $('#cm-online-count').textContent = String(on.length);
    $('#cm-online').replaceChildren(...(on.length ? on.map((p) => el('a', { class: 'cm-card', href: profileHref(p.user_id) },
      el('span', { class: 'cm-avatar', text: p.name.slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
      el('span', { class: 'cm-card-text' },
        el('strong', {}, el('span', { class: 'pl-dot online' }), p.name),
        el('small', { class: 'muted', text: `${ratingText(p.rating, p.provisional)} · ${p.games} rated game${p.games === 1 ? '' : 's'}` }))))
      : [el('p', { class: 'muted cm-nobody', text: 'Nobody else is on right now. Invite a friend: Play → Challenge a friend.' })]));
  }

  renderAll() {
    const q = $('#cm-search').value.trim().toLowerCase();
    $$('#cm-sort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === this.sort));
    const t = (s) => (s ? new Date(s).getTime() : 0);
    const by = {
      active: (a, b) => (b.online - a.online) || t(b.seen_at) - t(a.seen_at),
      rating: (a, b) => (b.games > 0) - (a.games > 0) || (b.rating ?? 0) - (a.rating ?? 0),
      games: (a, b) => b.games - a.games || (b.rating ?? 0) - (a.rating ?? 0),
      new: (a, b) => t(b.created_at) - t(a.created_at),
    }[this.sort];
    const rows = this.players.filter((p) => !q || p.name.toLowerCase().includes(q)).sort(by);
    $('#cm-body').replaceChildren(...rows.map((p) => el('tr', { dataset: { id: p.user_id }, title: `${p.name}'s profile` },
      el('td', {}, nameLink(p)),
      el('td', { class: 'num' }, el('strong', { text: ratingText(p.rating, p.provisional) })),
      el('td', { class: 'num', text: String(p.games) }),
      el('td', { class: p.online ? 'cm-on' : 'muted', text: p.online ? 'Online now' : p.seen_at ? ago(p.seen_at) : '–' }),
      el('td', { class: 'muted', text: new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) }))));
    $('#cm-empty').classList.toggle('hidden', rows.length > 0);
  }

  renderBoard() {
    // Everyone with a rated game, best first; a provisional rating counts as it stands, marked "?".
    const ranked = this.players.filter((p) => p.games > 0 && !p.banned)
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.games - a.games);
    const medals = ['i-medal-gold', 'i-medal-silver', 'i-medal-bronze'];
    const top = ranked.slice(0, 3);
    // The podium: second, first, third.
    const order = [1, 0, 2].filter((i) => top[i]);
    $('#cm-podium').replaceChildren(...order.map((i) => {
      const p = top[i];
      return el('a', { class: `cm-step cm-step-${i + 1}`, href: profileHref(p.user_id) },
        svg(medals[i], 'cm-medal'),
        el('span', { class: 'cm-avatar lg', text: p.name.slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
        el('strong', { class: 'cm-step-name' }, el('span', { class: `pl-dot${p.online ? ' online' : ''}` }), p.name),
        el('span', { class: 'cm-step-rating', text: ratingText(p.rating, p.provisional) }),
        el('small', { class: 'muted', text: `${p.games} rated game${p.games === 1 ? '' : 's'}` }),
        el('span', { class: 'cm-step-block', text: String(i + 1) }));
    }));
    $('#cm-podium').classList.toggle('hidden', !top.length);
    $('#cm-ranks').replaceChildren(...ranked.map((p, i) => el('tr', { dataset: { id: p.user_id }, class: i < 3 ? `cm-top cm-top-${i + 1}` : null },
      el('td', { class: 'num cm-rank', text: String(i + 1) }),
      el('td', {}, nameLink(p)),
      el('td', { class: 'num' }, el('strong', { text: ratingText(p.rating, p.provisional) }), el('small', { class: 'muted', text: ` ±${p.rd}` })),
      el('td', { class: 'num' }, progress(p.progress)),
      el('td', { class: 'num', text: String(p.games) }))));
    $('#cm-ranks-empty').classList.toggle('hidden', ranked.length > 0);
  }
}
