// The home page (after infinitechess.org's): the 5D title screen's vortex and flying pieces
// behind, three ways to play (a lobby game, a friend, Kairos), the lobby of open seeks, and the
// games being played now. The lobby is live: seeks come and go as people create, cancel and
// accept them; our own is green, a click cancels it; a click on another accepts it.
import { Rules } from './kairos.js';
import { TitleScreen } from './title-screen.js';
import { GameSetup } from './setup.js';
import { preview } from './openings.js';
import { sounds } from './sound.js';
import { sb, rpc, pid, tab, live, setPresence, serverNow, syncClock, report, onConnection } from './net.js';
import { tcLabel, tcText, speed, clockText } from './tc.js';
import { ratingText } from './account.js';
import { $, el, toast } from './util.js';

const TAGLINES = [
  'Chess with multiverse time travel', 'Every move a new timeline', 'Checkmate across time',
  'Travel back, branch out, mate forward', 'The board is only the beginning',
];
/** A lobby row that a different seek just slid into ignores clicks this long. */
const GRACE_MS = 667;
/** After this long without input the lobby stops updating ("Hover to reconnect."). */
const IDLE_MS = 30 * 60 * 1000;
/** A finished featured game stays on show this long. */
const HOLD_MS = 7000;
const MAX_FEATURED = 3;

/** localStorage key of the dismissed "New?" prompt; index.html's head script reads it too. */
const PROMPT_KEY = 'kairos.homePromptDismissed';

/**
 * The "New?" prompt above the lobby (after infinitechess.org's): "Take the tutorial" or "I'm
 * experienced". Either one hides it for good; on later visits the document's head script marks
 * <html data-home-prompt="dismissed"> before first paint, so it never flashes.
 */
function newPlayerPrompt() {
  const dismissed = () => { try { localStorage.setItem(PROMPT_KEY, '1'); } catch (e) { /* private mode */ } };
  $('#new-prompt-dismiss').onclick = () => {
    dismissed();
    $('#new-prompt').classList.add('collapsed');
  };
  $('#new-prompt-tutorial').addEventListener('click', dismissed);
}

export class Home {
  constructor(app) {
    this.app = app;
    this.seeks = new Map();
    this.seen = new Set();
    this.lastSeekSound = 0;
    this.slotTimes = [];
    this.ingame = null;
    this.games = new Map();
    this.featured = [];
  }

  async init() {
    newPlayerPrompt();
    this.rules = await Rules.create();
    this.variants = this.rules.call({ cmd: 'variants' }).variants;
    this.setup = new GameSetup(this.app, this.variants);
    this.title = new TitleScreen($('#title-canvas'), {
      onScore: (n) => {
        $('#annihilation').textContent = `Annihilated: ${n}`;
        $('#annihilation').classList.toggle('hidden', !n);
      },
    });
    $('#hero-tag').textContent = TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
    const created = (mode, r) => this.created(mode, r);
    $('#btn-create-game').onclick = () => this.setup.open('online', { onCreated: created });
    $('#btn-challenge-friend').onclick = () => this.setup.open('friend', { onCreated: created });
    $('#btn-play-ai').onclick = () => this.setup.open('computer', { onCreated: created });
    $('#seek-rows').addEventListener('click', (e) => {
      const row = e.target.closest('.seek-row[data-id]');
      if (row) this.clickSeek(row);
    });
    const wake = () => this.wake();
    $('#lobby-idle').addEventListener('pointerenter', wake);
    $('#lobby-idle').addEventListener('pointerdown', wake);
    for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
      document.addEventListener(ev, () => { this.lastInput = Date.now(); }, { capture: true, passive: true });
    }
    onConnection((on) => { if (on && this.active && !this.idle) this.refresh(); });
    setInterval(() => this.tick(), 1000);
  }

  activate(params) {
    this.active = true;
    this.lastInput = Date.now();
    this.title.start();
    const offline = !sb();
    $('#lobby-offline').classList.toggle('hidden', !offline);
    if (!offline) this.subscribe();
    // A position handed over from the editor or the analysis board: play it against Kairos.
    const position = params && params.get('position');
    if (params && params.get('play')) {
      history.replaceState(null, '', '#/');
      this.setup.open(params.get('play'), { position, onCreated: (mode, r) => this.created(mode, r) });
    }
  }

  deactivate() {
    this.active = false;
    this.title.stop();
    this.unsubscribe();
    // Leaving the lobby takes our public seek away (as closing it does).
    setPresence(null);
  }

  // ---------------------------------------------------------------- live data
  async subscribe() {
    if (this.subs) return;
    const me = await pid;
    this.subs = [
      live('lobby-seeks', { table: 'seeks', onChange: (p) => this.onSeek(p), onSync: () => this.loadSeeks() }),
      live(`active-${me}`, { table: 'active_players', filter: `player=eq.${me}`, onChange: (p) => this.onActive(p), onSync: () => this.loadActive() }),
      live('lobby-games', { table: 'live_games', onChange: (p) => this.onGame(p), onSync: () => this.loadGames() }),
      live('lobby-viewers', { presence: { key: tab, state: {} }, onPresence: (s) => { $('#lobby-viewers').textContent = Math.max(0, Object.keys(s).length - 1); } }),
    ];
    syncClock();
  }

  unsubscribe() {
    if (this.subs) for (const off of this.subs) off();
    this.subs = null;
  }

  refresh() {
    this.loadSeeks();
    this.loadActive();
    this.loadGames();
  }

  async loadSeeks() {
    const { data, error } = await sb().from('seeks')
      .select('id,created_at,owner,variant,base_ms,inc_ms,delay_ms,tl_delay_ms,color,rated,owner_name,owner_rating,owner_provisional').order('created_at');
    if (error) return;
    const fresh = new Map(data.map((s) => [s.id, s]));
    this.seeks = fresh;
    this.renderSeeks({ initial: !this.loadedOnce });
    this.loadedOnce = true;
  }

  onSeek(p) {
    if (p.eventType === 'DELETE') this.seeks.delete(p.old.id);
    else if (!p.new.private) this.seeks.set(p.new.id, p.new);
    this.renderSeeks();
  }

  async loadActive() {
    const me = await pid;
    const { data } = await sb().from('active_players').select('*').eq('player', me);
    this.setIngame(data && data[0], { fresh: true });
  }

  onActive(p) {
    if (p.eventType === 'DELETE') this.setIngame(null);
    else this.setIngame(p.new, { fresh: p.eventType === 'INSERT' });
  }

  /** In a game: this tab goes there if it is the one the game was started from, else the banner. */
  setIngame(a, { fresh = false } = {}) {
    this.ingame = a || null;
    if (a && fresh && a.navigate_tab === tab && this.active) {
      sounds.play('start');
      location.hash = `#/game/${a.game_id}`;
      return;
    }
    $('#lobby-ingame').classList.toggle('hidden', !a);
    if (a) $('#lobby-rejoin').href = `#/game/${a.game_id}`;
    for (const id of ['#btn-create-game', '#btn-challenge-friend', '#btn-play-ai']) $(id).disabled = !!a;
    if (a && this.setup.dialog.open) this.setup.dialog.close();
  }

  async created(mode, r) {
    if (mode === 'friend') location.hash = `#/game/${r.id}`;
    else if (mode === 'computer') {
      sounds.play('start');
      location.hash = `#/game/${r.id}`;
    } else {
      // Our seek is in the lobby: stay here (the page tells the server we are) until accepted.
      setPresence('lobby');
      this.loadSeeks();
    }
  }

  // ---------------------------------------------------------------- the lobby
  async renderSeeks({ initial = false } = {}) {
    const me = await pid;
    const rows = [...this.seeks.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const ours = rows.find((s) => s.owner === me);
    // Our public seek lives while we are in the lobby.
    if (this.active) setPresence(ours ? 'lobby' : null);
    // A new seek from someone else: a sound (at most one per 10 s).
    let fresh = false;
    for (const s of rows) {
      if (!this.seen.has(s.id)) {
        this.seen.add(s.id);
        if (!initial && s.owner !== me) fresh = true;
      }
    }
    if (fresh && Date.now() - this.lastSeekSound > 10000) {
      this.lastSeekSound = Date.now();
      sounds.play('move');
    }
    // A row whose seek changed is unclickable for a moment (a click meant for the old one).
    const now = performance.now();
    const old = this.slots || [];
    this.slots = rows.map((s) => s.id);
    this.slots.forEach((id, i) => {
      if (old[i] !== undefined && old[i] !== id && !(rows[i].owner === me && this.seeks.get(old[i])?.owner === me)) this.slotTimes[i] = now;
    });
    $('#seek-rows').replaceChildren(...rows.map((s, i) => {
      const mine = s.owner === me;
      const graced = this.slotTimes[i] && now - this.slotTimes[i] < GRACE_MS;
      const side = s.color ? el('span', { class: `side-dot ${s.color === 1 ? 'white' : 'black'}`, title: `Invite owner chooses to be ${s.color === 1 ? 'white' : 'black'}` }) : null;
      const tc = { base_ms: s.base_ms, inc_ms: s.inc_ms, delay_ms: s.delay_ms, tl_delay_ms: s.tl_delay_ms };
      const row = el('div', {
        class: 'seek-row' + (mine ? ' ours' : '') + (initial || this.pulsed?.has(s.id) ? '' : ' fresh'), role: 'row',
        dataset: { id: s.id }, title: mine ? 'Cancel seek' : 'Accept seek', tabindex: '0',
        'aria-disabled': graced ? 'true' : 'false',
      },
      el('span', { role: 'cell', class: 'seek-player' }, side, mine ? '(You)' : s.owner_name || 'Anonymous',
        s.owner_rating != null && !mine ? el('span', { class: 'seek-rating', text: ratingText(s.owner_rating, s.owner_provisional) }) : null),
      el('span', { role: 'cell', class: 'seek-variant', text: s.variant.replace(/^Standard - /, '') }),
      el('span', { role: 'cell', class: 'seek-time', title: `${speed(tc)} · ${tcText(tc)} · ${s.rated ? 'Rated' : 'Casual'}` },
        el('span', { class: 'speed', text: speed(tc) }), tcLabel(tc), s.rated ? el('span', { class: 'seek-rated', text: 'Rated' }) : null));
      row.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.clickSeek(row); } };
      return row;
    }));
    this.pulsed = new Set(rows.map((s) => s.id));
    if (rows.some((_, i) => this.slotTimes[i] && now - this.slotTimes[i] < GRACE_MS)) setTimeout(() => this.renderSeeks(), GRACE_MS);
    $('#lobby-empty').classList.toggle('hidden', rows.length > 0);
  }

  async clickSeek(row) {
    if (row.getAttribute('aria-disabled') === 'true' || this.busy) return;
    const s = this.seeks.get(row.dataset.id);
    if (!s) return;
    const me = await pid;
    this.busy = true;
    try {
      if (s.owner === me) await rpc('seek_cancel', { p_id: s.id });
      else {
        if (this.ingame) return toast("You're already in a game.");
        const r = await rpc('seek_accept', { p_tab: tab, p_id: s.id });
        if (r && r.id) {
          sounds.play('start');
          location.hash = `#/game/${r.id}`;
        }
      }
    } catch (e) {
      report(e);
      this.loadSeeks();
    } finally {
      this.busy = false;
    }
  }

  // ---------------------------------------------------------------- idleness
  tick() {
    if (!this.active) return;
    if (!this.idle && Date.now() - this.lastInput > IDLE_MS) {
      // Unless we have a seek waiting for an opponent, stop following the lobby.
      const ours = [...this.seeks.values()].some((s) => s.owner === this.mePid);
      if (!ours) {
        this.idle = true;
        this.unsubscribe();
        $('#lobby-idle').classList.remove('hidden');
      }
    }
    this.tickClocks();
  }

  wake() {
    if (!this.idle) return;
    this.idle = false;
    this.lastInput = Date.now();
    $('#lobby-idle').classList.add('hidden');
    this.subscribe();
  }

  // ---------------------------------------------------------------- games being played
  async loadGames() {
    pid.then((p) => { this.mePid = p; });
    const { data, error } = await sb().from('live_games')
      .select('id,variant,position,moves,ply,white,black,engine_color,engine_level,private,base_ms,inc_ms,delay_ms,tl_delay_ms,white_ms,black_ms,color_ticking,turn_started_at,turn_delay_ms,result,termination,ended_at,updated_at,rated,white_name,black_name,white_rating,black_rating,white_rd,black_rd')
      .order('updated_at', { ascending: false }).limit(50);
    if (error) return;
    this.games = new Map(data.map((g) => [g.id, g]));
    this.renderGames();
  }

  onGame(p) {
    if (p.eventType === 'DELETE') this.games.delete(p.old.id);
    else this.games.set(p.new.id, p.new);
    clearTimeout(this.gamesTimer);
    this.gamesTimer = setTimeout(() => this.renderGames(), 250);
  }

  /** Up to three live public games: people against people first, then the most recently active. */
  renderGames() {
    const now = Date.now();
    const playing = [...this.games.values()].filter((g) => !g.private && !g.result);
    $('#featured-title').textContent = `${playing.length} Active Game${playing.length === 1 ? '' : 's'}`;
    const keep = this.featured.filter((id) => {
      const g = this.games.get(id);
      return g && !g.private && (!g.result || now - Date.parse(g.ended_at) < HOLD_MS);
    });
    const rank = (g) => (g.engine_color == null ? 0 : 1);
    const candidates = playing.filter((g) => !keep.includes(g.id))
      .sort((a, b) => rank(a) - rank(b) || (a.updated_at < b.updated_at ? 1 : -1));
    this.featured = [...keep, ...candidates.map((g) => g.id)].slice(0, MAX_FEATURED);
    $('#featured-grid').replaceChildren(...this.featured.map((id) => this.card(this.games.get(id))));
    this.tickClocks();
  }

  card(g) {
    const name = (side) => (g.engine_color === side ? `Kairos${g.engine_level < 8 ? ` · Level ${g.engine_level}` : ''}`
      : (side === 1 ? g.white_name : g.black_name) || 'Anonymous');
    const rating = (side) => {
      const r = side === 1 ? g.white_rating : g.black_rating;
      return g.rated && r != null ? el('span', { class: 'fg-rating', text: ratingText(Math.trunc(r), (side === 1 ? g.white_rd : g.black_rd) >= 110) }) : null;
    };
    const bar = (side) => el('div', { class: 'fg-bar' }, el('span', { class: `side-dot ${side === 1 ? 'white' : 'black'}` }), el('span', { class: 'fg-name', text: name(side) }),
      rating(side), el('span', { class: 'fg-clock', dataset: { side } }));
    let board = el('div', { class: 'fg-board' });
    try {
      this.rules.call({ cmd: 'new', position: g.position });
      let node = 0;
      if (g.moves.length) node = this.rules.call({ cmd: 'play_line', node: 0, line: g.moves.map((m) => m.lan + ' submit').join(' ') }).node;
      board = preview(this.rules.call({ cmd: 'view', node, draft: [] }).view);
      board.classList.add('fg-board');
    } catch (e) { /* the card shows no board */ }
    const result = g.result ? el('div', { class: 'fg-result', text: g.result === '*' ? 'Aborted' : g.result.replace('1/2-1/2', '½-½') }) : null;
    const tc = { base_ms: g.base_ms, inc_ms: g.inc_ms, delay_ms: g.delay_ms, tl_delay_ms: g.tl_delay_ms };
    return el('a', { class: 'featured-card', href: `#/game/${g.id}`, dataset: { id: g.id }, title: `${g.variant} · ${tcText(tc)}` },
      bar(2), board, bar(1), el('div', { class: 'fg-meta', text: `${g.variant.replace(/^Standard - /, '')} · ${tcLabel(tc)} · ${g.ply} action${g.ply === 1 ? '' : 's'}` }), result);
  }

  tickClocks() {
    for (const c of document.querySelectorAll('#featured-grid .fg-clock')) {
      const g = this.games.get(c.closest('.featured-card').dataset.id);
      if (!g || g.base_ms == null) { c.textContent = ''; continue; }
      const side = +c.dataset.side;
      let ms = side === 1 ? g.white_ms : g.black_ms;
      if (g.color_ticking === side && !g.result) ms -= Math.max(0, serverNow() - Date.parse(g.turn_started_at) - g.turn_delay_ms);
      c.textContent = clockText(ms);
      c.classList.toggle('running', g.color_ticking === side && !g.result);
    }
  }
}
