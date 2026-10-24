// The header's menus, after lichess's: the account menu ("dasher": your profile, editing it,
// preferences, fair play for admins and signing out, then sound, theme, board colours and keyboard
// shortcuts, each a small pane with a way back; a guest gets the settings alone, behind the gear),
// and the challenges sent to you from your profile page, to accept or decline. A menu closes on a
// click outside it, on Escape and when the page changes.
import { account, openSignIn, signOut, profileHref, ratingText } from './account.js';
import { query, report } from './net.js';
import { sounds } from './sound.js';
import { tcLabel } from './tc.js';
import { $, el, toast } from './util.js';

const THEMES = [['system', 'Device theme'], ['light', 'Light'], ['dark', 'Dark']];
const BOARDS = [['brown', 'Brown'], ['blue', 'Blue'], ['green', 'Green']];
/** How often the signed-in player's incoming challenges are fetched while the page is visible. */
const CHALLENGE_POLL_MS = 12000;

let opts = null; // {themePref(), setTheme(pref), setBoard(name), openSettings(), openHelp(), editProfile()}
let open = null; // {drop, button} of the open menu
let pane = 'main';

function svgUse(id) {
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${id}`);
  return use;
}
/** An <svg> made in the SVG namespace (el() makes HTML elements). */
function svg(id, cls) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('aria-hidden', 'true');
  if (cls) s.setAttribute('class', cls);
  s.append(svgUse(id));
  return s;
}

// ---------------------------------------------------------------- menus
function show(drop, button) {
  if (open && open.drop !== drop) close();
  drop.classList.remove('hidden');
  button.setAttribute('aria-expanded', 'true');
  open = { drop, button };
}

function close() {
  if (!open) return;
  open.drop.classList.add('hidden');
  open.button.setAttribute('aria-expanded', 'false');
  open = null;
  pane = 'main';
}

function toggle(drop, button, render) {
  if (open && open.drop === drop) return close();
  render();
  show(drop, button);
}

// ---------------------------------------------------------------- the account menu
function renderAccountButton() {
  const p = account.profile;
  const btn = $('#btn-account');
  btn.classList.toggle('signed-in', !!p);
  btn.replaceChildren(...(p
    ? [el('span', { class: 'acct-dot', 'aria-hidden': 'true' }), el('span', { class: 'acct-name', text: p.name }),
      el('span', { class: 'acct-rating', text: ratingText(p.rating, p.provisional) }), svg('i-chevron-right', 'acct-caret')]
    : [el('span', { text: 'Sign in' })]));
  btn.title = p ? `${p.name} · ${ratingText(p.rating, p.provisional)}` : 'Sign in to play rated games';
  btn.setAttribute('aria-haspopup', p ? 'true' : 'dialog');
  $('#btn-dasher').classList.toggle('hidden', !!p);
  if (open && open.drop === $('#dasher')) renderDasher();
}

function item(iconId, text, attrs) {
  return el(attrs.href ? 'a' : 'button', { class: 'dasher-item', type: attrs.href ? null : 'button', ...attrs }, svg(iconId), el('span', { text }));
}

function sub(name, label, value) {
  return el('button', { type: 'button', class: 'dasher-sub', onclick: (e) => { e.stopPropagation(); pane = name; renderDasher(); } },
    el('span', { text: label }), el('span', { class: 'dasher-value', text: value }), svg('i-chevron-right'));
}

function back(label) {
  return el('button', { type: 'button', class: 'dasher-back', onclick: (e) => { e.stopPropagation(); pane = 'main'; renderDasher(); } },
    svg('i-chevron-left'), el('span', { text: label }));
}

function choice(label, active, onclick, extra = null) {
  return el('button', { type: 'button', class: `dasher-choice${active ? ' on' : ''}`, 'aria-pressed': String(active),
    onclick: (e) => { e.stopPropagation(); onclick(); renderDasher(); } }, svg('i-check', 'dasher-check'), extra, el('span', { text: label }));
}

function renderDasher() {
  const d = $('#dasher');
  const p = account.profile;
  const theme = opts.themePref();
  const board = document.documentElement.dataset.board;
  if (pane === 'sound') {
    const vol = el('input', { type: 'range', min: 0, max: 100, step: 5, value: Math.round(sounds.volume * 100), 'aria-label': 'Volume', class: 'dasher-volume' });
    vol.onclick = (e) => e.stopPropagation();
    vol.onchange = () => { sounds.setVolume(vol.value / 100); renderDasher(); };
    d.replaceChildren(back('Sound'),
      el('div', { class: 'dasher-choices' }, choice('On', sounds.enabled, () => sounds.set(true)), choice('Off', !sounds.enabled, () => sounds.set(false))),
      el('label', { class: `dasher-slider${sounds.enabled ? '' : ' off'}` }, el('span', { text: `Volume ${Math.round(sounds.volume * 100)}%` }), vol));
    return;
  }
  if (pane === 'theme') {
    d.replaceChildren(back('Theme'), el('div', { class: 'dasher-choices' },
      ...THEMES.map(([k, label]) => choice(label, theme === k, () => opts.setTheme(k)))));
    return;
  }
  if (pane === 'board') {
    d.replaceChildren(back('Board'), el('div', { class: 'dasher-choices' },
      ...BOARDS.map(([k, label]) => choice(label, board === k, () => opts.setBoard(k), el('span', { class: `dasher-swatch board-${k}`, 'aria-hidden': 'true' })))));
    return;
  }
  const links = p ? el('div', { class: 'dasher-links' },
    el('a', { class: 'dasher-user', href: profileHref(p.user_id) },
      el('span', { class: 'dasher-avatar', text: (p.name || '?').slice(0, 1).toUpperCase(), 'aria-hidden': 'true' }),
      el('span', { class: 'dasher-who' }, el('strong', { text: p.name }), el('small', { text: `${ratingText(p.rating, p.provisional)} · Profile` }))),
    item('i-edit', 'Edit profile', { onclick: () => { close(); opts.editProfile(); } }),
    item('i-gear', 'Preferences', { onclick: () => { close(); opts.openSettings(); } }),
    p.admin ? item('i-shield', 'Fair play', { href: '#/admin' }) : null,
    item('i-power', 'Sign out', { class: 'dasher-item signout', onclick: () => { close(); signOut(); } })) : null;
  d.replaceChildren(...[links,
    el('div', { class: 'dasher-subs' },
      sub('sound', 'Sound', sounds.enabled ? `${Math.round(sounds.volume * 100)}%` : 'Off'),
      sub('theme', 'Theme', THEMES.find(([k]) => k === theme)[1]),
      sub('board', 'Board', BOARDS.find(([k]) => k === board)?.[1] || ''),
      p ? null : item('i-gear', 'Preferences', { onclick: () => { close(); opts.openSettings(); } }),
      item('i-keyboard', 'Keyboard shortcuts', { onclick: () => { close(); opts.openHelp(); } }))].filter(Boolean));
}

// ---------------------------------------------------------------- challenges to you
let incoming = [];
let seen = null; // ids already announced (null until the first fetch: no sound for what was there)
let pollTimer = null;

async function pollChallenges() {
  clearTimeout(pollTimer);
  if (!account.profile) { setIncoming([]); return; }
  if (document.visibilityState === 'visible') {
    try {
      setIncoming(await query('challenges_incoming'));
    } catch (e) { /* offline: try again later */ }
  }
  pollTimer = setTimeout(pollChallenges, CHALLENGE_POLL_MS);
}

function setIncoming(list) {
  incoming = list || [];
  const fresh = seen ? incoming.filter((c) => !seen.has(c.id)) : [];
  seen = new Set(incoming.map((c) => c.id));
  if (fresh.length) {
    sounds.play('start');
    toast(`${fresh[0].owner_name} challenges you to a game`);
  }
  $('#hdr-challenges').classList.toggle('hidden', !account.profile);
  const n = $('#btn-challenges-count');
  n.textContent = incoming.length ? String(incoming.length) : '';
  n.classList.toggle('hidden', !incoming.length);
  $('#btn-challenges').title = incoming.length ? `${incoming.length} challenge${incoming.length === 1 ? '' : 's'}` : 'Challenges';
  if (open && open.drop === $('#challenge-drop')) renderChallenges();
}

function sideText(c) {
  if (!c.color) return 'Random side';
  return c.color === 1 ? 'You play Black' : 'You play White';
}

function renderChallenges() {
  const d = $('#challenge-drop');
  if (!incoming.length) {
    d.replaceChildren(el('div', { class: 'challenge-empty' }, svg('i-swords'), el('p', { text: 'No challenges.' }),
      el('small', { class: 'muted', text: 'Challenge someone from their profile.' })));
    return;
  }
  d.replaceChildren(el('h3', { class: 'challenge-head', text: 'Challenges' }), ...incoming.map((c) => {
    const tc = { base_ms: c.base_ms, inc_ms: c.inc_ms, delay_ms: c.delay_ms, tl_delay_ms: c.tl_delay_ms };
    return el('div', { class: 'challenge-item' },
      el('div', { class: 'challenge-who' },
        c.owner_user ? el('a', { href: profileHref(c.owner_user), text: c.owner_name, onclick: () => close() }) : el('strong', { text: c.owner_name }),
        c.owner_rating != null ? el('span', { class: 'muted', text: ` ${ratingText(c.owner_rating, c.owner_provisional)}` }) : null),
      el('div', { class: 'challenge-props muted', text: `${c.rated ? 'Rated' : 'Casual'} · ${c.base_ms == null ? 'Unlimited' : tcLabel(tc)} · ${c.variant.replace(/^Standard - /, '')} · ${sideText(c)}` }),
      el('div', { class: 'challenge-btns' },
        el('button', { type: 'button', class: 'btn sm primary', onclick: () => {
          close();
          setIncoming(incoming.filter((x) => x.id !== c.id));
          location.hash = `#/game/${c.id}?accept=1`;
        } }, svg('i-check'), 'Accept'),
        el('button', { type: 'button', class: 'btn sm', onclick: async (e) => {
          e.stopPropagation();
          try { await query('challenge_decline', { p_id: c.id }); } catch (err) { report(err); }
          setIncoming(incoming.filter((x) => x.id !== c.id));
        } }, svg('i-x'), 'Decline')));
  }));
}

// ---------------------------------------------------------------- start
/** Bind the header's menus. */
export function initHeader(o) {
  opts = o;
  const dasher = $('#dasher');
  $('#btn-account').onclick = () => (account.profile ? toggle(dasher, $('#btn-account'), renderDasher) : openSignIn());
  $('#btn-dasher').onclick = () => toggle(dasher, $('#btn-dasher'), renderDasher);
  $('#btn-challenges').onclick = () => toggle($('#challenge-drop'), $('#btn-challenges'), renderChallenges);
  document.addEventListener('pointerdown', (e) => {
    if (open && !open.drop.contains(e.target) && !open.button.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { close(); e.stopPropagation(); } }, true);
  window.addEventListener('hashchange', close);
  account.onChange(() => {
    renderAccountButton();
    seen = null;
    pollChallenges();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && account.profile) pollChallenges(); });
  renderAccountButton();
}

/** Fetch the incoming challenges now (after one was accepted elsewhere, say). */
export function refreshChallenges() { pollChallenges(); }
