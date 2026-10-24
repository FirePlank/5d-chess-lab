// Your games: your online games (played from this browser, or with your account from any
// browser once you are signed in; stored on the server), the games you finished against Kairos on the old Play page and the
// analyses you saved on the analysis board (kept in this browser, history.js). An online game
// opens on its game page, the others on the analysis board; a local one's name and players can
// be edited, and the local ones exported as JSONL records.
import { $, el, toast, confirmDialog } from './util.js';
import { listGames, deleteGame, clearGames, recordLine, updateGame } from './history.js';
import { sb, pid } from './net.js';
import { resultText } from './online.js';
import { account } from './account.js';
import { tcLabel } from './tc.js';

/** Your online games from the server (finished, with at least one action), newest first. */
async function onlineGames() {
  const c = sb();
  if (!c) return [];
  const me = await pid;
  const user = account.profile && account.profile.user_id;
  const { data, error } = await c.from('player_games')
    .select('color, score, game:games(id, created_at, ended_at, variant, result, termination, move_count, base_ms, inc_ms, delay_ms, tl_delay_ms, white_name, black_name)')
    .or(user ? `player.eq.${me},user_id.eq.${user}` : `player.eq.${me}`).limit(500);
  if (error || !data) return [];
  return data.filter((r) => r.game).map((r) => {
    const g = r.game;
    const human = r.color === 1 ? 'white' : 'black';
    const opponent = (r.color === 1 ? g.black_name : g.white_name) || 'Anonymous';
    return {
      id: `o:${g.id}`, online: g.id, kind: 'online', started: Date.parse(g.created_at), ended: Date.parse(g.ended_at),
      variant: g.variant, human, white: r.color === 1 ? 'You' : opponent, black: r.color === 2 ? 'You' : opponent,
      result: g.result, reason: resultText(g.result, g.termination), moves: { length: g.move_count },
      timeControl: tcLabel(g), engine: /^Kairos/.test(opponent) ? { version: opponent } : null,
    };
  });
}

export class Games {
  constructor(app) {
    this.app = app;
    this.games = [];
  }

  init() {
    for (const id of ['f-result', 'f-variant', 'f-kind']) $('#' + id).onchange = () => this.render();
    $('#games-body').addEventListener('click', (e) => {
      const act = e.target.closest('button[data-act]');
      const tr = e.target.closest('tr[data-id]');
      if (!tr) return;
      if (tr.dataset.online) return void (location.hash = `#/game/${tr.dataset.online}`);
      const id = +tr.dataset.id;
      if (act && act.dataset.act === 'delete') return this.remove(id);
      if (act && act.dataset.act === 'edit') return this.edit(id);
      location.hash = `#/analysis?game=${id}`;
    });
    $('#games-export').onclick = () => this.exportAll();
    $('#games-clear').onclick = async () => {
      const local = this.games.filter((g) => g.kind !== 'online').length;
      if (!local) return;
      if (await confirmDialog('Delete every game?', { text: `All ${local} games kept in this browser are deleted (online games stay on the server).`, ok: 'Delete all', danger: true })) {
        await clearGames();
        this.load();
      }
    };
    $('#edit-save').onclick = (e) => { e.preventDefault(); this.saveEdit(); };
    // Signing in (or the session coming back) adds the account's games from other browsers.
    account.onChange(() => { if (this.app.route === 'games') this.load(); });
  }

  activate() { this.load(); }

  async load() {
    let local = [];
    try {
      local = await listGames();
    } catch (e) {
      toast('Could not read the saved games: ' + e.message, { error: true });
    }
    const online = await onlineGames().catch(() => []);
    this.games = [...online, ...local].sort((a, b) => (b.ended || b.started || 0) - (a.ended || a.started || 0));
    const variants = [...new Set(this.games.map((g) => g.variant).filter(Boolean))].sort();
    const sel = $('#f-variant'), cur = sel.value;
    sel.replaceChildren(el('option', { value: '', text: 'All variants' }), ...variants.map((v) => el('option', { value: v, text: v })));
    sel.value = variants.includes(cur) ? cur : '';
    this.render();
  }

  /** The outcome for you: won/lost/drawn in your games, else the result. */
  static outcome(g) {
    if (g.result === '*' && g.kind === 'online') return { key: '', text: 'Aborted' };
    if (g.kind !== 'analysis' && g.human && g.result) {
      const mine = g.human === 'white' ? '1-0' : '0-1';
      if (g.result === mine) return { key: 'win', text: 'Won' };
      if (g.result === '1/2-1/2') return { key: 'draw', text: 'Drawn' };
      return { key: 'loss', text: 'Lost' };
    }
    return { key: g.result === '1/2-1/2' ? 'draw' : '', text: g.result ? g.result.replace('1/2-1/2', '½–½') : '*' };
  }

  static title(g) {
    return g.name || `${g.white || 'White'} vs ${g.black || 'Black'}`;
  }

  render() {
    const result = $('#f-result').value, variant = $('#f-variant').value, kind = $('#f-kind').value;
    const shown = this.games.filter((g) => (!variant || g.variant === variant)
      && (!kind || (g.kind || 'played') === kind)
      && (!result || Games.outcome(g).key === result));
    $('#browser-title').textContent = this.games.length ? `Your games · ${shown.length} of ${this.games.length}` : 'Your games';
    const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const rows = shown.map((g) => {
      const o = Games.outcome(g);
      const saved = g.kind === 'analysis';
      const online = g.kind === 'online';
      return el('tr', { dataset: online ? { id: g.id, online: g.online } : { id: g.id }, title: online ? 'Open the game' : 'Open on the analysis board' },
        el('td', { class: 'date-cell', text: fmtDate(g.ended || g.started), title: saved ? (g.saved ? `Last saved ${fmtDate(g.saved)}` : '')
          : [g.started && g.ended ? `Started ${fmtDate(g.started)} · ended ${fmtDate(g.ended)}` : '', g.saved ? `analysis saved ${fmtDate(g.saved)}` : ''].filter(Boolean).join(' · ') }),
        el('td', { class: 'name-cell' }, el('span', { class: 'kind ' + (saved ? 'saved' : online ? 'online' : 'played'), text: saved ? 'Analysis' : online ? 'Online' : 'Played' }), Games.title(g),
          g.notes ? el('span', { class: 'notes', text: g.notes, title: g.notes }) : null),
        el('td', { class: 'variant-cell' }, g.variant || '',
          g.opening ? el('span', { class: 'opening-name', text: g.opening, title: g.opening }) : null),
        el('td', { class: 'res ' + o.key, text: o.text, title: g.result || '' }),
        el('td', { class: 'reason', text: g.reason || '', title: g.reason || '' }),
        el('td', { class: 'num', text: g.moves ? g.moves.length : '', dataset: { unit: g.moves && g.moves.length === 1 ? ' action' : ' actions' } }),
        el('td', { class: 'tc-cell', text: g.timeControl || '' }),
        el('td', { class: 'engine-cell', text: [g.engine && g.engine.version, g.skillLevel != null ? `Level ${g.skillLevel}` : ''].filter(Boolean).join(' · '), title: g.engine ? engineTitle(g.engine) : '' }),
        el('td', { class: 'del' }, online ? null : el('button', { type: 'button', dataset: { act: 'edit' }, title: 'Edit name and players', 'aria-label': 'Edit', text: '✎' }),
          online ? null : el('button', { type: 'button', dataset: { act: 'delete' }, title: 'Delete this game', 'aria-label': 'Delete', text: '×' })));
    });
    $('#games-body').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { colspan: 9, class: 'empty-state',
      text: this.games.length ? 'No games match these filters.' : 'No games yet. Play one from the home page, or save one from the analysis board.' }))]));
  }

  async remove(id) {
    const g = this.games.find((x) => x.id === id);
    if (!g || !(await confirmDialog('Delete this game?', { text: Games.title(g), ok: 'Delete', danger: true }))) return;
    await deleteGame(id);
    this.load();
  }

  /** The edit dialog: name, players and notes. */
  edit(id) {
    const g = this.games.find((x) => x.id === id);
    if (!g) return;
    this.editing = id;
    $('#edit-name').value = g.name || '';
    $('#edit-name').placeholder = `${g.white || 'White'} vs ${g.black || 'Black'}`;
    $('#edit-white').value = g.white || '';
    $('#edit-black').value = g.black || '';
    $('#edit-notes').value = g.notes || '';
    $('#dlg-edit').showModal();
  }

  async saveEdit() {
    const val = (id) => $(id).value.trim();
    await updateGame(this.editing, { name: val('#edit-name'), white: val('#edit-white') || 'White', black: val('#edit-black') || 'Black', notes: val('#edit-notes') });
    $('#dlg-edit').close();
    this.load();
  }

  exportAll() {
    const local = this.games.filter((g) => g.kind !== 'online');
    if (!local.length) return toast('No games to export');
    const blob = new Blob([local.map(recordLine).join('\n') + '\n'], { type: 'application/x-ndjson' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `kairos-games-${new Date().toISOString().slice(0, 10)}.jsonl` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

function engineTitle(e) {
  const parts = [e.version];
  if (e.where === 'browser') parts.push(`in the browser, ${e.threads} thread${e.threads === 1 ? '' : 's'}, ${e.hashMb} MB hash`);
  if (e.where === 'server') parts.push('on the kairos-web server');
  return parts.join(' · ');
}
