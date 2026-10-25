// An online game's page, #/game/<id> (after infinitechess.org's game and challenge pages). The
// same link is first a private challenge (its owner shares it; a friend accepts), then the game:
// two people, or one against Kairos running in their browser (this page plays its actions); and
// anyone else watches. The server keeps the clocks and decides every result; this page shows the
// game live, sends actions, and follows the server: a player who leaves (the opponent may claim
// the game after 10 s if they closed the page, 60 s if they lost connection), draw offers, the
// rematch handshake, and chat (private games).
import { Rules } from './kairos.js';
import { sounds } from './sound.js';
import { moveText } from './notation.js';
import { preview } from './openings.js';
import { lanText } from './input.js';
import { sb, rpc, edge, pid, tab, live, setPresence, serverNow, syncClock, onConnection, onPing, intent, isOutstanding, report } from './net.js';
import { tcLabel, tcText, speed, clockText } from './tc.js';
import { account, ratingText, profileHref, refreshAccount } from './account.js';
import * as fairplay from './fairplay.js';
import { reportCrash } from './crash.js';
import { $, el, toast, onWindow } from './util.js';

/** An action block that appears ignores clicks this long (one meant for the block it replaced). */
const GRACE_MS = 667;
/** Draw offers and resignation need a second click within this long. */
const CONFIRM_MS = 3000;
/** Kairos's think time per action in a game without a clock. */
const UNTIMED_MOVETIME = 3000;
/** Kairos's search is tried this many times (the engine restarted between) before the game is aborted. */
const ENGINE_TRIES = 3;

const NOTICES = {
  'draw-offered': ['You offered a draw.', 'Opponent offered a draw.'],
  'draw-declined': ['Draw offer declined.', 'Draw offer declined.'],
  'draw-accepted': ['Draw offer accepted.', 'Draw offer accepted.'],
  'rematch-offered': ['You offered a rematch.', 'Opponent offered a rematch.'],
  'rematch-accepted': ['Rematch accepted.', 'Rematch accepted.'],
  'disconnect-voluntary': ['You disconnected.', 'Opponent disconnected.'],
  'disconnect-involuntary': ['You lost connection.', 'Opponent lost connection.'],
  reconnected: ['You reconnected.', 'Opponent reconnected.'],
  'postgame-left': ['You left.', 'Opponent left.'],
  'postgame-returned': ['You returned.', 'Opponent returned.'],
};

/** "White wins by checkmate." and the like, for a finished game. */
export function resultText(result, termination) {
  if (result === '*' || termination === 'aborted') return 'Game aborted';
  const winner = result === '1-0' ? 'White' : result === '0-1' ? 'Black' : null;
  const label = {
    checkmate: 'checkmate', exiled: 'exiling every king', time: 'time forfeit', resignation: 'resignation',
    disconnect: 'abandonment', stalemate: 'stalemate', agreement: 'agreement', abandonment: 'abandonment',
  }[termination] || termination;
  return winner ? `${winner} wins by ${label}.` : `Draw by ${label}.`;
}

export class OnlineGame {
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.input = app.input;
    this.engine = app.engine;
    this.source = {
      mode: 'play',
      rules: null,
      node: () => this.cur,
      canMove: () => this.myTurn(),
      blocked: () => this.blockedHint(),
      submit: (moves) => this.submit(moves),
      onView: (v, draft) => {
        if (draft && draft.length) fairplay.boardTouched();
        this.onView(v);
      },
      onClick: (sq) => {
        if (sq && this.myTurn()) fairplay.boardTouched();
        return false;
      },
    };
    onWindow('notation-change', () => { if (this.tree) this.renderMoves(); });
  }

  async init() {
    this.rules = await Rules.create();
    this.source.rules = this.rules;
    this.engine.on((m) => this.onEngine(m));
    $('#og-moves').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (c) this.goto(+c.dataset.id);
    });
    $('#og-nav-first').onclick = () => this.step('first');
    $('#og-nav-prev').onclick = () => this.step('prev');
    $('#og-nav-next').onclick = () => this.step('next');
    $('#og-nav-last').onclick = () => this.step('last');
    this.confirmable($('#og-draw'), () => this.act('draw', 'game_offer_draw', {}, () => this.canOfferDraw()));
    this.confirmable($('#og-resign'), () => this.act('resign', 'game_resign', {}, () => this.live() && this.row.ply > 1));
    $('#og-abort').onclick = () => this.act('abort', 'game_abort', {}, () => this.live() && this.row.ply <= 2);
    $('#og-draw-yes').onclick = (e) => this.graced(e) || this.act('draw-answer', 'game_answer_draw', { p_accept: true }, () => this.drawOffered());
    $('#og-draw-no').onclick = (e) => this.graced(e) || this.act('draw-answer', 'game_answer_draw', { p_accept: false }, () => this.drawOffered());
    $('#og-claim-win').onclick = () => this.act('claim', 'game_claim', { p_draw: false }, () => this.live());
    $('#og-claim-draw').onclick = () => this.act('claim', 'game_claim', { p_draw: true }, () => this.live());
    $('#og-rematch').onclick = (e) => this.graced(e) || this.rematch();
    $('#og-chat-form').onsubmit = (e) => { e.preventDefault(); this.say(); };
    $('#og-chat-input').oninput = () => $('#og-chat-error').classList.add('hidden');
    $('#challenge-copy').onclick = () => this.copyLink();
    $('#challenge-cancel').onclick = () => this.cancelChallenge();
    $('#challenge-accept').onclick = () => this.acceptChallenge();
    onPing((r) => {
      if (this.active && r.superseded && this.role && this.row && !this.superseded) {
        this.superseded = true;
        toast('Another window connected to the game.');
        location.hash = '#/';
      }
    });
    onConnection((on) => this.onConnection(on));
    document.addEventListener('visibilitychange', () => this.flashTitle());
    window.addEventListener('beforeunload', (e) => {
      // Leaving a game in progress: the browser asks first.
      if (this.active && this.role && this.live() && !this.leaving) e.preventDefault();
    });
    setInterval(() => this.tick(), 100);
    setInterval(() => this.renderMeta(), 30000);
  }

  // ---------------------------------------------------------------- page life
  async activate(params) {
    this.active = true;
    const id = params && params.get('id');
    if (!id || !/^[0-9A-Za-z]{4,16}$/.test(id)) {
      location.hash = '#/';
      return;
    }
    // Accept from the header's challenges: the challenge opens and is accepted at once.
    this.autoAccept = params.get('accept') === '1';
    if (this.autoAccept) history.replaceState(null, '', `#/game/${id}`);
    // Always (re)open: coming back to a game is a reconnect (the server closes our absence).
    await this.open(id);
  }

  deactivate() {
    this.active = false;
    fairplay.gameOver();
    this.turnOn = false;
    this.loading(false);
    this.close();
    $('#challenge').classList.add('hidden');
  }

  close() {
    if (this.offs) for (const off of this.offs) off();
    this.offs = null;
    setPresence(null);
    this.stopEngine();
    this.restoreTitle();
  }

  reset() {
    this.close();
    Object.assign(this, {
      row: null, role: null, finished: null, tree: null, cur: 0, lans: [], start: null, pending: null,
      chat: [], chatSince: 0, searchFor: null, flagFor: null, lowtimePlayed: false, superseded: false,
      detached: false, spectators: 0, me: null, prevRow: null, revealAt: 0,
    });
  }

  async open(id) {
    this.reset();
    this.id = id;
    this.engineTries = 0;
    // Nothing is shown until the game is drawn from our side: the board still holds the page
    // shown before (as infinitechess.org keeps its canvas hidden until the game has loaded).
    this.loading(true);
    this.me = await pid;
    if (!sb()) {
      toast('Online play is not available right now.', { error: true });
      return;
    }
    let st;
    try {
      st = await rpc('challenge_open', { p_tab: tab, p_id: id });
    } catch (e) {
      report(e);
      return;
    }
    if (this.id !== id) return;
    if (st.kind === 'open') {
      this.showChallenge(st);
      if (this.autoAccept && !st.owner && !st.ingame) this.acceptChallenge();
      this.autoAccept = false;
      return;
    }
    await this.openGame();
  }

  // ---------------------------------------------------------------- the challenge page
  showChallenge(st) {
    this.challenge = st;
    this.lastChallenge = st;
    $('#workspace').classList.add('hidden');
    $('#challenge').classList.remove('hidden');
    const s = st.seek;
    const tc = { base_ms: s.base_ms, inc_ms: s.inc_ms, delay_ms: s.delay_ms, tl_delay_ms: s.tl_delay_ms };
    const to = s.to_user ? s.to_name : null;
    $('#challenge-title').textContent = to ? (st.owner ? `Challenge to ${to}` : `Challenge from ${s.owner_name}`)
      : st.owner ? 'Challenge a friend' : 'Open challenge';
    $('#challenge-wait').textContent = to ? `Waiting for ${to} to accept. They see your challenge at the top of every page; you can also send them this link:`
      : 'Send this link to your friend to play:';
    const side = s.color ? (st.owner ? (s.color === 1 ? 'You play White' : 'You play Black') : (s.color === 1 ? 'You play Black' : 'You play White')) : 'Sides drawn at random';
    $('#challenge-props').replaceChildren(...[
      el('span', { text: s.variant }), ' · ', el('span', { title: tcText(tc), text: `${speed(tc)} ${tcLabel(tc)}` }), ' · ',
      el('span', { text: s.rated ? 'Rated' : 'Casual' }), ' · ', el('span', { text: side }),
      !st.owner && s.owner_name ? el('span', { text: ` · from ${s.owner_name}${s.owner_rating != null ? ` (${ratingText(s.owner_rating, s.owner_provisional)})` : ''}` }) : null,
    ].filter((x) => x != null));
    try {
      this.rules.call({ cmd: 'new', position: s.position });
      $('#challenge-preview').replaceChildren(preview(this.rules.call({ cmd: 'view', node: 0, draft: [] }).view));
    } catch (e) { $('#challenge-preview').replaceChildren(); }
    $('#challenge-owner').classList.toggle('hidden', !st.owner);
    $('#challenge-visitor').classList.toggle('hidden', st.owner);
    $('#challenge-link').textContent = this.link();
    $('#challenge-ingame').classList.toggle('hidden', !st.ingame);
    if (st.ingame) $('#challenge-rejoin').href = `#/game/${st.ingame.id}`;
    const mine = !s.to_user || (account.profile && account.profile.user_id === s.to_user);
    $('#challenge-accept').disabled = !!st.ingame || !mine;
    $('#challenge-notyours').classList.toggle('hidden', mine);
    if (!mine) $('#challenge-notyours').textContent = `This challenge is for ${s.to_name}.`;
    // The owner's page keeps the challenge alive (it expires 10 minutes after the owner leaves).
    if (st.owner) setPresence('challenge', this.id);
    const id = this.id;
    this.offs = [
      // Accepted or cancelled: its seek goes.
      live(`challenge-${id}`, {
        table: 'seeks', filter: `id=eq.${id}`,
        onChange: (p) => { if (p.eventType === 'DELETE') this.challengeGone(); },
      }),
      live(`challenge-active-${this.me}`, {
        table: 'active_players', filter: `player=eq.${this.me}`,
        onChange: (p) => {
          if (p.eventType !== 'DELETE' && p.new.game_id === id) this.challengeGone();
          else if (p.eventType !== 'DELETE') this.setChallengeIngame(p.new);
          else this.setChallengeIngame(null);
        },
      }),
    ];
  }

  setChallengeIngame(a) {
    $('#challenge-ingame').classList.toggle('hidden', !a);
    if (a) $('#challenge-rejoin').href = `#/game/${a.game_id}`;
    $('#challenge-accept').disabled = !!a;
  }

  /** The challenge became a game (go and play it, or watch), or was cancelled (home). */
  async challengeGone() {
    if (!this.challenge) return;
    const id = this.id;
    const st = await rpc('challenge_open', { p_tab: tab, p_id: id }).catch(() => null);
    if (!st || this.id !== id || st.kind === 'open') return;
    this.challenge = null;
    if (st.kind === 'game') {
      if (st.role) sounds.play('start');
      if (this.offs) for (const off of this.offs) off();
      this.offs = null;
      setPresence(null);
      await this.openGame();
    } else {
      // The owner's page only sees it go when it wasn't them: declined (or expired).
      const st0 = this.lastChallenge;
      toast(st0 && st0.owner && st0.seek.to_name ? `${st0.seek.to_name} declined your challenge.` : 'The challenge was cancelled.');
      location.hash = '#/';
    }
  }

  link() {
    return `${location.origin}${location.pathname}#/game/${this.id}`;
  }

  async copyLink() {
    try {
      await navigator.clipboard.writeText(this.link());
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents($('#challenge-link'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      document.execCommand('copy');
    }
    const label = $('#challenge-link');
    label.textContent = '✓ Copied';
    setTimeout(() => { if (this.challenge) label.textContent = this.link(); }, 1500);
  }

  async cancelChallenge() {
    this.challenge = null; // our own cancel: no "declined" when its seek goes
    try {
      await rpc('seek_cancel', { p_id: this.id });
      location.hash = '#/';
    } catch (e) { report(e); }
  }

  async acceptChallenge() {
    const btn = $('#challenge-accept');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const r = await rpc('seek_accept', { p_tab: tab, p_id: this.id });
      if (r && r.id) {
        sounds.play('start');
        this.challenge = null;
        if (this.offs) for (const off of this.offs) off();
        this.offs = null;
        await this.openGame();
      }
    } catch (e) {
      report(e);
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- the game
  async openGame() {
    const id = this.id;
    let r;
    try {
      r = await rpc('game_open', { p_tab: tab, p_id: id });
    } catch (e) {
      report(e);
      return;
    }
    if (this.id !== id) return;
    if (!r.game) {
      toast('That game does not exist.', { error: true });
      location.hash = '#/';
      return;
    }
    $('#challenge').classList.add('hidden');
    $('#workspace').classList.remove('hidden');
    syncClock();
    // Our side first, so the board is never drawn from the wrong one.
    this.role = r.role || null;
    this.orient();
    if (!r.live) {
      this.finished = r.game;
      this.loadMoves(r.game.position, r.game.moves.map((m) => m.lan));
      this.showGame();
      return;
    }
    if (this.role) setPresence('game', id);
    this.offs = [live(`game-${id}`, {
      table: 'live_games', filter: `id=eq.${id}`,
      onChange: (p) => {
        if (p.eventType === 'DELETE') this.evicted();
        else this.applyRow(p.new);
      },
      onSync: () => this.refetch(),
      presence: { key: tab, state: { role: this.role } },
      onPresence: (s) => {
        // Spectators: the people on this page that are not playing.
        this.spectators = Object.values(s).flat().filter((m) => !m.role).length;
        this.renderMeta();
      },
    })];
    this.applyRow(r.game, { initial: true });
    if (this.role) this.loadChat();
    this.showGame();
  }

  async refetch() {
    if (!this.row) return;
    const { data } = await sb().from('live_games').select('*').eq('id', this.id).maybeSingle();
    if (data) this.applyRow(data, { resync: true });
    else this.evicted();
  }

  /** The live row went (both players left after the game): it stays on screen, from the record. */
  async evicted() {
    if (this.detached) return;
    this.detached = true;
    const { data } = await sb().from('games').select('*').eq('id', this.id).maybeSingle();
    if (data) {
      this.finished = data;
      // The row we hold may predate the end (the update never reached us, or the row went
      // right after it): it takes the record's result, so the clocks stop and the result shows.
      if (this.row && !this.row.result) this.endWith(data);
    }
    this.render();
  }

  /** The held live row, ended as the finished game's record says (and its last actions played). */
  endWith(game) {
    const lans = game.moves.map((m) => m.lan);
    this.row = { ...this.row, result: game.result, termination: game.termination, color_ticking: null, draw_offer: null, white_claim_at: null, black_claim_at: null, moves: game.moves, ply: lans.length,
      white_diff: game.white_diff, black_diff: game.black_diff };
    this.applyRow(this.row, { resync: true });
    this.revealAt = performance.now();
    if (this.active) sounds.end(game.result, this.role === 1 ? 'w' : this.role === 2 ? 'b' : null);
  }

  /** The board from our side (White's for a spectator), framed afresh. */
  orient() {
    // This page's game drives the shared board from here on (not the page shown before).
    this.input.attach(this.source);
    this.board.setFlipped(this.role === 2);
    this.board.fitted = false;
  }

  showGame() {
    if (!this.active) return;
    this.input.attach(this.source);
    this.render();
    this.loading(false);
  }

  loading(on) {
    $('#board').style.visibility = on ? 'hidden' : '';
    $('#side-game').classList.toggle('loading', on);
  }

  /** Rebuild the local game from a start and its actions. */
  loadMoves(start, lans) {
    const r = this.rules.call({ cmd: 'new', position: start });
    this.tree = r.tree;
    this.start = start;
    this.lans = [];
    let node = 0;
    for (const lan of lans) {
      const p = this.rules.call({ cmd: 'play', node, lan });
      this.tree = p.tree;
      node = p.node;
      this.lans.push(lan);
    }
    this.cur = node;
  }

  lastNode() {
    if (!this.tree) return 0;
    let c = 0;
    while (this.tree.nodes[c].children.length) c = this.tree.nodes[c].children[this.tree.nodes[c].children.length - 1];
    return c;
  }

  /** A new state of the game from the server (realtime, a refetch, or the page opening). */
  applyRow(row, { initial = false, resync = false } = {}) {
    const prev = this.row;
    this.row = row;
    const lans = row.moves.map((m) => m.lan);
    const atEnd = this.cur === this.lastNode();
    // Our own action, sent and shown at once, until the server has it.
    if (this.pending && lans.length > this.pending.ply) this.pending = null;
    const local = this.pending ? this.lans.slice(0, this.pending.ply) : this.lans;
    const prefix = this.start === row.position && local.length <= lans.length && local.every((m, i) => m === lans[i]);
    if (this.pending && !resync && lans.length === this.pending.ply) {
      // Still on its way: keep showing it.
    } else if (!prefix) {
      this.loadMoves(row.position, lans);
      this.pending = null;
    } else {
      let node = this.pending ? this.nodeAtPly(this.pending.ply) : this.lastNode();
      if (this.pending) {
        // Truncate the unconfirmed action before replaying the server's.
        this.loadMoves(row.position, lans);
        this.pending = null;
        node = this.lastNode();
      } else {
        for (let i = this.lans.length; i < lans.length; i++) {
          const p = this.rules.call({ cmd: 'play', node, lan: lans[i] });
          this.tree = p.tree;
          node = p.node;
          this.lans.push(lans[i]);
          if (!initial && this.active && (atEnd || i === lans.length - 1)) sounds.action(this.tree.nodes[node].san, { check: !row.result });
        }
      }
      if (atEnd) {
        if (this.cur !== node) this.input.reset();
        this.cur = node;
      }
    }
    // Events.
    if (!initial && prev) {
      if (row.result && !prev.result && this.active) sounds.end(row.result, this.role === 1 ? 'w' : this.role === 2 ? 'b' : null);
      // A rated game of ours ended: the header shows the new rating.
      if (row.result && !prev.result && row.rated && this.role) refreshAccount();
      const opp = this.role ? 3 - this.role : null;
      if (opp && row.draw_offer === opp && prev.draw_offer !== opp) {
        this.revealAt = performance.now();
        sounds.play('start', { volume: 0.6 });
      }
      if (row.result && !prev.result) this.revealAt = performance.now();
    }
    if (row.rematch_id && (!prev || !prev.rematch_id)) {
      sounds.play('start');
      location.hash = `#/game/${row.rematch_id}`;
      return;
    }
    if (this.role && row.chat_count > this.chatSince) this.loadChat();
    if (row.result) this.stopEngine();
    this.fairplayTrack();
    this.render();
    this.maybeThink();
  }

  /**
   * Fair play (fairplay.js): time our turns, in every game we play (against Kairos too), and
   * announce a live game against a person to this browser's other tabs.
   */
  fairplayTrack() {
    const r = this.row;
    if (!r || !this.role || !this.live() || !this.active) {
      fairplay.gameOver();
      this.turnOn = false;
      return;
    }
    if (!r.engine_color) fairplay.gameLive(this.id, this.rules.call({ cmd: 'view', node: this.lastNode(), draft: [] }).view, r.ply);
    const mine = r.to_move === this.role && !this.pending;
    if (mine && !this.turnOn) fairplay.turnStarted();
    this.turnOn = mine;
  }

  nodeAtPly(ply) {
    let c = 0;
    for (let i = 0; i < ply && this.tree.nodes[c].children.length; i++) c = this.tree.nodes[c].children[0];
    return c;
  }

  live() { return !!(this.row && !this.row.result && !this.detached); }

  side() { return this.row ? this.row.to_move : null; }

  /** The human of this page moves now (not Kairos's turn). */
  myTurn() {
    const r = this.row;
    if (!r || !this.role || !this.live() || this.pending || this.cur !== this.lastNode()) return false;
    if (r.engine_color && r.to_move === r.engine_color) return false;
    return r.to_move === this.role;
  }

  blockedHint() {
    const r = this.row;
    if (!r && this.finished) toast('The game is over');
    else if (!this.role) toast('You are watching this game');
    else if (!this.live()) toast('The game is over');
    else if (this.cur !== this.lastNode()) toast('Go to the latest position to move');
    else if (r.engine_color && r.to_move === r.engine_color) toast('Kairos is thinking…');
    else toast("It is your opponent's turn");
  }

  /** Send our action (shown at once; the server confirms or the page resyncs). */
  async submit(moves) {
    const r = this.row;
    if (!this.myTurn()) return;
    const lan = moves.map(lanText).join(' ');
    const ply = r.ply;
    const p = this.rules.call({ cmd: 'play', node: this.cur, moves });
    this.tree = p.tree;
    this.cur = p.node;
    this.lans.push(this.tree.nodes[p.node].lan);
    this.pending = { ply, lan: this.tree.nodes[p.node].lan };
    sounds.action(this.tree.nodes[p.node].san, { move: false, check: true });
    this.restoreTitle();
    this.turnOn = false;
    const signals = fairplay.takeSignals();
    this.render();
    await this.send(ply, this.pending.lan, signals);
  }

  /** Send an action (ours, with its turn's fair-play `signals`, or Kairos's). */
  async send(ply, lan, signals = undefined) {
    let res;
    try {
      res = await edge('move', { id: this.id, ply, lan, signals });
    } catch (e) {
      report(e);
      // Sent again once the connection returns (if the game still waits for it).
      if (e.network) this.retryMove = { ply, lan, signals };
      else this.refetch();
      return;
    }
    if (res && res.error) {
      if (res.error === 'illegal') toast('Oops! That was an illegal move. If this is a bug, please report it!', { error: true });
      this.pending = null;
      this.refetch();
    }
  }

  // ---------------------------------------------------------------- Kairos
  /** Against Kairos, on its turn: this page searches and sends its action. */
  maybeThink() {
    const r = this.row;
    if (!r || !r.engine_color || !this.role || !this.live() || this.superseded) return;
    if (r.to_move !== r.engine_color || this.pending) {
      if (this.searchFor != null && this.searchFor !== r.ply) this.stopEngine();
      return;
    }
    if (this.searchFor === r.ply) return;
    this.searchFor = r.ply;
    const node = this.nodeAtPly(r.ply);
    const position = this.rules.call({ cmd: 'view', node, draft: [] }).view.position;
    const left = this.timeLeft(r.engine_color);
    const limits = r.base_ms != null
      ? { movetime: null, timeLeft: Math.max(100, Math.round(left.ms)), increment: r.inc_ms, delay: r.delay_ms, delayPerTimeline: r.tl_delay_ms }
      : { movetime: UNTIMED_MOVETIME };
    const p = this.engine.search({ position, newGame: r.ply <= 1, book: r.engine_book !== false, skillLevel: r.engine_level || 8, ...limits });
    this.searchId = this.engine.reqId;
    p.catch((e) => this.engineFailed(e));
  }

  stopEngine() {
    if (this.searchId != null && this.engine.reqId === this.searchId) this.engine.stop();
    this.searchId = null;
    this.searchFor = null;
  }

  async onEngine(m) {
    if (this.searchId == null || m.id !== this.searchId) return;
    if (m.type === 'error') return this.engineFailed(new Error(m.message));
    if (m.type !== 'done') return;
    const r = this.row;
    const ply = this.searchFor;
    this.searchId = null;
    if (!r || !this.live() || r.ply !== ply) return;
    // No action in a game still on (the server ends it at mate or stalemate): the search failed.
    if (!m.bestmove) return this.engineFailed(new Error('Kairos’s search returned no action'));
    this.engineTries = 0;
    await this.send(ply, m.bestmove);
  }

  /**
   * Kairos's search failed in this browser: restart the engine and search again; after
   * ENGINE_TRIES failures the game is aborted (never a win for either side: game zVqatR was
   * given to the player as Kairos's resignation).
   */
  engineFailed(e) {
    if (!this.live() || !this.row.engine_color) return;
    console.error(e);
    this.searchId = null;
    this.engineTries = (this.engineTries || 0) + 1;
    if (this.engineTries < ENGINE_TRIES) {
      const ply = this.row.ply;
      this.engine.restart();
      setTimeout(() => {
        if (this.searchFor !== ply || this.searchId != null) return;
        this.searchFor = null;
        this.maybeThink();
      }, 1000 * this.engineTries);
      return;
    }
    reportCrash({ message: e.message, stage: `online game, ${ENGINE_TRIES} tries`, game: this.id, ply: this.row.ply,
      position: this.engine.lastPosition });
    toast(`The engine could not run in this browser (${e.message}), so the game was aborted.`, { error: true });
    rpc('engine_resign', { p_id: this.id }).catch(report);
  }

  // ---------------------------------------------------------------- actions
  /** A player's action through the intent layer (held across a lost connection). */
  async act(key, fn, args, valid) {
    if (!valid()) return;
    try {
      await intent(key, fn, { p_id: this.id, ...args }, valid);
    } catch (e) { report(e); }
    this.render();
  }

  /** A button that needs a second click within 3 s. */
  confirmable(btn, fn) {
    btn.onclick = () => {
      if (btn.classList.contains('confirming')) {
        btn.classList.remove('confirming');
        clearTimeout(btn.confirmTimer);
        fn();
      } else {
        btn.classList.add('confirming');
        btn.title = 'Click again to confirm';
        btn.confirmTimer = setTimeout(() => { btn.classList.remove('confirming'); btn.title = btn.dataset.title || ''; }, CONFIRM_MS);
      }
    };
    btn.dataset.title = btn.title;
  }

  /** A click on a block that only just appeared is ignored. */
  graced(e) {
    if (performance.now() - this.revealAt < GRACE_MS) { e.preventDefault(); return true; }
    return false;
  }

  drawOffered() {
    return this.live() && this.role && this.row.draw_offer === 3 - this.role;
  }

  canOfferDraw() {
    const r = this.row;
    if (!this.live() || !this.role || r.engine_color || r.ply <= 1 || r.draw_offer) return false;
    const last = this.role === 1 ? r.white_last_offer_ply : r.black_last_offer_ply;
    return last == null || r.ply - last >= 2;
  }

  async rematch() {
    const btn = $('#og-rematch');
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const build = this.app.build && this.app.build.engine ? this.app.build.engine.sha.slice(0, 7) : null;
      const r = await rpc('game_rematch', { p_tab: tab, p_id: this.id, p_version: build });
      if (r && r.id) {
        sounds.play('start');
        location.hash = `#/game/${r.id}`;
      }
    } catch (e) {
      report(e);
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- chat
  async loadChat() {
    if (this.chatLoading) return;
    this.chatLoading = true;
    try {
      const lines = await rpc('game_chat', { p_id: this.id, p_since: this.chatSince });
      for (const c of lines) if (c.idx >= this.chatSince) { this.chat.push(c); this.chatSince = c.idx + 1; }
      this.renderChat();
    } catch (e) { /* the next change retries */ } finally {
      this.chatLoading = false;
    }
  }

  async say() {
    const input = $('#og-chat-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      await rpc('game_say', { p_id: this.id, p_text: text });
      input.value = '';
    } catch (e) {
      $('#og-chat-error').textContent = e.message;
      $('#og-chat-error').classList.remove('hidden');
      clearTimeout(this.chatErrTimer);
      this.chatErrTimer = setTimeout(() => $('#og-chat-error').classList.add('hidden'), 10000);
    }
  }

  renderChat() {
    const box = $('#og-chat-log');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
    box.replaceChildren(...this.chat.map((c) => {
      const mine = c.player === this.role;
      if (c.notice) {
        const words = NOTICES[c.notice];
        return el('div', { class: 'chat-notice', text: words ? words[mine ? 0 : 1] : c.notice });
      }
      return el('div', { class: 'chat-line' }, el('b', { text: mine ? 'You: ' : 'Opponent: ' }), c.message);
    }));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- connection
  onConnection(on) {
    if (!this.active || !this.role || !this.live()) return;
    const self = $('#og-self');
    clearTimeout(this.selfTimer);
    if (!on) {
      self.textContent = 'You have disconnected.';
      self.className = 'self-disconnect lost';
    } else {
      this.refetch().then(() => {
        if (this.retryMove && this.row && this.row.ply === this.retryMove.ply) this.send(this.retryMove.ply, this.retryMove.lan, this.retryMove.signals);
        this.retryMove = null;
      });
      if (!self.classList.contains('hidden')) {
        self.textContent = 'Reconnected.';
        self.className = 'self-disconnect';
        this.selfTimer = setTimeout(() => self.classList.add('hidden'), 2000);
      }
    }
    this.render();
  }

  // ---------------------------------------------------------------- tab title
  flashTitle() {
    const r = this.row;
    const ours = this.active && this.myTurn();
    if (!document.hidden || !ours) return this.restoreTitle();
    if (this.titleTimer) return;
    this.baseTitle = this.baseTitle || document.title;
    let on = false;
    this.titleTimer = setInterval(() => { on = !on; document.title = on ? 'YOUR MOVE' : this.baseTitle; }, 1500);
    // Still away after 20 s: one reminder sound.
    if (r && r.ply >= 2) this.reminder = setTimeout(() => sounds.play('move'), 20000);
  }

  restoreTitle() {
    clearInterval(this.titleTimer);
    clearTimeout(this.reminder);
    this.titleTimer = null;
    if (this.baseTitle) document.title = this.baseTitle;
  }

  // ---------------------------------------------------------------- clocks
  /** {ms, delayLeft} on `side`'s clock now. */
  timeLeft(side) {
    const r = this.row;
    let ms = side === 1 ? r.white_ms : r.black_ms;
    let delayLeft = 0;
    if (r.color_ticking === side && !r.result) {
      const elapsed = serverNow() - Date.parse(r.turn_started_at);
      delayLeft = Math.max(0, r.turn_delay_ms - elapsed);
      ms -= Math.max(0, elapsed - r.turn_delay_ms);
    }
    return { ms: Math.max(0, ms), delayLeft };
  }

  /**
   * The clocks as they were at the action shown, as lila's replay shows them: each side's time
   * when it last moved by then (the start time before its first action); `moves[i].clk` is the
   * mover's time after action i, increment included. Null at the live end of a game in progress
   * (or one whose live row we hold): those clocks run from the row.
   */
  pastClocks() {
    const g = this.row || this.finished;
    const n = this.tree && this.tree.nodes[this.cur];
    if (!g || g.base_ms == null || !n || (this.row && this.cur === this.lastNode())) return null;
    if (this.firstMoverOf !== this.start) {
      this.firstMoverOf = this.start;
      this.firstMover = this.rules.call({ cmd: 'view', node: 0, draft: [] }).view.player === 1 ? 2 : 1;
    }
    const out = { 1: g.base_ms, 2: g.base_ms };
    const moves = g.moves || [];
    for (let i = 0; i < Math.min(n.ply, moves.length); i++) {
      if (moves[i].clk != null) out[i % 2 === 0 ? this.firstMover : 3 - this.firstMover] = moves[i].clk;
    }
    // A game lost on time ends with the loser's flag down.
    if (g.termination === 'time' && !n.children.length) out[g.result === '1-0' ? 2 : 1] = 0;
    return out;
  }

  /** The clocks of `pastClocks` on the player bars, stopped. */
  showPastClocks(past) {
    const g = this.row || this.finished;
    for (const [pos, side] of this.bars()) {
      $(`#og-${pos}-clock`).textContent = clockText(past[side]);
      $(`#og-${pos}-delay`).textContent = '';
      const bar = $(`#og-${pos}`);
      bar.classList.remove('running', 'delaying');
      bar.classList.toggle('lowtime', past[side] < g.base_ms / 8);
    }
  }

  tick() {
    if (!this.active || !this.row || this.row.base_ms == null) return;
    const r = this.row;
    const past = this.pastClocks();
    // A spectator reads the game again now and then: a realtime message that never came (a
    // dropped connection, the row gone right after the end) must not leave it watching a
    // clock that runs on in a game that is over.
    if (!this.role && this.live() && performance.now() > (this.nextPoll || 0)) {
      this.nextPoll = performance.now() + 10000;
      this.refetch();
    }
    for (const [pos, side] of this.bars()) {
      const { ms, delayLeft } = this.timeLeft(side);
      const running = r.color_ticking === side && !r.result;
      if (!past) {
        $(`#og-${pos}-clock`).textContent = clockText(ms);
        $(`#og-${pos}-delay`).textContent = running && delayLeft > 0 ? `${r.active_timelines} TL · ${(delayLeft / 1000).toFixed(1)}s` : '';
        const bar = $(`#og-${pos}`);
        bar.classList.toggle('running', running && delayLeft <= 0);
        bar.classList.toggle('delaying', running && delayLeft > 0);
        bar.classList.toggle('lowtime', ms < r.base_ms / 8);
      }
      // A flag fell on this display: the server decides (once per turn).
      if (running && ms <= 0 && this.flagFor !== r.turn_started_at) {
        this.flagFor = r.turn_started_at;
        rpc('game_check', { p_id: this.id }).catch(() => {});
      }
      // Our clock below an eighth of the start: one sound per game.
      if (running && side === this.role && !this.lowtimePlayed && ms < r.base_ms / 8 && r.base_ms >= 60000) {
        this.lowtimePlayed = true;
        sounds.play('end', { volume: 0.7 });
      }
    }
    if (this.row && this.oppClaimAt) this.renderOpponent();
  }

  /** [[position, side]]: us (or White, watching) at the bottom. */
  bars() {
    const bottom = this.role || 1;
    return [['top', 3 - bottom], ['bottom', bottom]];
  }

  // ---------------------------------------------------------------- drawing
  name(side) {
    const r = this.row || this.finished;
    if (!r) return '';
    if (this.row && r.engine_color === side) return `Kairos${r.engine_level < 8 ? ` · Level ${r.engine_level}` : ''}`;
    const named = side === 1 ? r.white_name : r.black_name;
    if (!this.row) return named || (side === this.role ? 'You' : 'Anonymous');
    return named || (side === this.role ? 'You' : 'Anonymous');
  }

  /** A side's rating going into a rated game, and its change once it ended: "1500? +12". */
  ratingOf(side) {
    const r = this.row || this.finished;
    if (!r || !r.rated) return '';
    const rating = side === 1 ? r.white_rating : r.black_rating;
    const rd = side === 1 ? r.white_rd : r.black_rd;
    const diff = side === 1 ? r.white_diff : r.black_diff;
    if (rating == null) return '';
    return ratingText(Math.trunc(rating), rd >= 110) + (diff == null ? '' : ` ${diff > 0 ? '+' : diff < 0 ? '−' : '±'}${Math.abs(diff)}`);
  }

  render() {
    if (!this.active) return;
    const r = this.row;
    const f = !r ? this.finished : null;
    if (!r && !f) return;
    for (const [pos, side] of this.bars()) {
      const nameEl = $(`#og-${pos}-name`);
      nameEl.textContent = this.name(side) || (f ? (side === 1 ? f.white_name : f.black_name) : '');
      const user = (r || f) && (side === 1 ? (r || f).white_user : (r || f).black_user);
      if (user) nameEl.href = profileHref(user); else nameEl.removeAttribute('href');
      const diff = (r || f) && (side === 1 ? (r || f).white_diff : (r || f).black_diff);
      const ratingEl = $(`#og-${pos}-rating`);
      ratingEl.textContent = this.ratingOf(side);
      ratingEl.classList.toggle('up', diff > 0);
      ratingEl.classList.toggle('down', diff < 0);
      $(`#og-${pos}-dot`).className = `side-dot ${side === 1 ? 'white' : 'black'}`;
      $(`#og-${pos}`).classList.toggle('tempo', !!(r && this.live() && r.to_move === side));
      if (!r || r.base_ms == null) {
        $(`#og-${pos}-clock`).textContent = '';
        $(`#og-${pos}`).classList.remove('running', 'delaying', 'lowtime');
      }
    }
    const past = this.pastClocks();
    if (past) this.showPastClocks(past);
    const result = r ? r.result : f.result;
    const termination = r ? r.termination : f.termination;
    const at = this.tree && this.tree.nodes[this.cur];
    $('#og-nav-first').disabled = $('#og-nav-prev').disabled = !at || at.parent == null;
    $('#og-nav-next').disabled = $('#og-nav-last').disabled = !at || !at.children.length;
    $('#og-result').classList.toggle('hidden', !result);
    if (result) {
      $('#og-result-score').textContent = result === '*' ? '' : result.replace('1/2-1/2', '½-½');
      $('#og-result-text').textContent = resultText(result, termination);
    }
    // Status line.
    let status = '';
    if (r && this.live()) {
      if (this.pending) status = 'Sending…';
      else if (r.engine_color && r.to_move === r.engine_color) status = 'Kairos is thinking…';
      else if (this.role) status = r.to_move === this.role ? 'Your move' : "Opponent's move";
      else status = `${r.to_move === 1 ? 'White' : 'Black'} to move`;
    } else if (result) status = '';
    $('#og-status').textContent = status;
    $('#og-status').classList.toggle('yours', !!(r && this.myTurn()));
    // Exactly one action block.
    const over = !!result;
    const offered = !over && this.drawOffered();
    $('#og-actions-over').classList.toggle('hidden', !over);
    $('#og-actions-draw').classList.toggle('hidden', !offered);
    $('#og-actions-live').classList.toggle('hidden', over || offered || !this.role);
    $('#og-actions-spectate').classList.toggle('hidden', over || !!this.role);
    if (r && this.role && !over) {
      $('#og-draw').classList.toggle('hidden', !!r.engine_color);
      $('#og-draw').disabled = !this.canOfferDraw() || isOutstanding('draw');
      $('#og-abort').classList.toggle('hidden', r.ply >= 2);
      $('#og-resign').classList.toggle('hidden', r.ply < 2);
      $('#og-abort').disabled = isOutstanding('abort');
      $('#og-resign').disabled = isOutstanding('resign');
    }
    if (over) {
      const players = this.role && this.row && !this.detached;
      $('#og-rematch').classList.toggle('hidden', !players);
      if (players) {
        const mine = this.role === 1 ? r.white_rematch : r.black_rematch;
        const theirs = this.role === 1 ? r.black_rematch : r.white_rematch;
        const gone = this.role === 1 ? r.black_gone : r.white_gone;
        $('#og-rematch').disabled = mine || (!r.engine_color && gone);
        $('#og-rematch').classList.toggle('rematch-offered', !!theirs && !mine);
        $('#og-rematch').title = mine ? 'Waiting for your opponent' : theirs ? 'Your opponent wants a rematch: accept' : !r.engine_color && gone ? 'Your opponent left' : 'Rematch';
      }
      const g = r || f;
      const lans = g.moves.map((m) => m.lan);
      $('#og-analysis').classList.toggle('hidden', !lans.length);
      // Short and shareable: the game's id, and /b for a game we played as Black.
      $('#og-analysis').href = `#/analysis/${this.id}${this.role === 2 ? '/b' : ''}`;
    }
    this.renderOpponent();
    if (!this.role || !this.live()) $('#og-self').classList.add('hidden');
    else if ($('#og-self').classList.contains('lost')) $('#og-self').classList.remove('hidden');
    // Chat: the players of a game between people (writing only in a private game).
    const chatShown = !!(r && this.role && !r.engine_color);
    $('#og-chat').classList.toggle('hidden', !chatShown);
    if (chatShown) {
      const input = $('#og-chat-input');
      input.disabled = !r.private || this.detached;
      input.placeholder = r.private ? 'Please be nice!' : 'Chat is open in private games.';
    }
    this.renderMeta();
    this.board.setOverlay({ readonly: !this.myTurn(), pv: [] });
    this.renderMoves();
    if (this.tree) {
      try { this.input.refresh(true); } catch (e) { /* redrawn on the next change */ }
    }
    $('#eval-bar').classList.add('hidden');
    this.flashTitle();
  }

  /** The opponent's absence: a countdown to the claim, then Claim victory / Call a draw. */
  renderOpponent() {
    const r = this.row;
    const box = $('#og-opp');
    const opp = this.role ? 3 - this.role : null;
    const claimAt = r && opp && !r.engine_color && this.live() ? (opp === 1 ? r.white_claim_at : r.black_claim_at) : null;
    this.oppClaimAt = claimAt;
    const lost = $('#og-self').classList.contains('lost');
    box.classList.toggle('hidden', !claimAt || lost);
    if (!claimAt || lost) return;
    const voluntary = opp === 1 ? r.white_claim_voluntary : r.black_claim_voluntary;
    const lead = voluntary ? 'Opponent disconnected.' : 'Opponent lost connection.';
    let text = lead;
    let claimable = false;
    if (r.ply >= 2) {
      const secs = Math.ceil((Date.parse(claimAt) - serverNow()) / 1000);
      if (secs > 0) text = `${lead} You can claim victory in ${secs} second${secs === 1 ? '' : 's'}.`;
      else { text = `${lead} You may claim victory, call a draw, or wait.`; claimable = true; }
    }
    $('#og-opp-text').textContent = text;
    $('#og-claims').classList.toggle('hidden', !claimable);
    $('#og-claim-win').disabled = $('#og-claim-draw').disabled = isOutstanding('claim');
  }

  renderMeta() {
    if (!this.active) return;
    const g = this.row || this.finished;
    if (!g) return;
    const tc = { base_ms: g.base_ms, inc_ms: g.inc_ms, delay_ms: g.delay_ms, tl_delay_ms: g.tl_delay_ms };
    const mins = Math.round((Date.now() - Date.parse(g.created_at)) / 60000);
    const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago` : `${Math.round(mins / 60)} h ago`;
    $('#og-meta').replaceChildren(
      el('div', { class: 'og-meta-line' }, el('b', { text: g.variant }), ` · ${speed(tc)} ${tcLabel(tc)}`,
        (this.row && this.row.engine_color) ? ' · Against Kairos' : g.rated ? ' · Rated' : ' · Casual', g.private ? ' · Private' : ''),
      el('div', { class: 'og-meta-line muted', title: tcText(tc), text: `Started ${ago}` }));
    $('#og-watchers').classList.toggle('hidden', !this.spectators);
    $('#og-watchers-n').textContent = this.spectators;
  }

  onView(v) {
    const chip = $('#status-chip');
    chip.className = 'status-line';
    if (v.status === 'checkmate') { chip.textContent = `Checkmate · ${v.player ? 'White' : 'Black'} wins`; chip.classList.add('over'); }
    else if (v.status === 'stalemate') { chip.textContent = 'Stalemate · draw'; chip.classList.add('over'); }
    else if (v.status === 'exiled-white' || v.status === 'exiled-black') { chip.textContent = `Exiled kings · ${v.status === 'exiled-white' ? 'Black' : 'White'} wins`; chip.classList.add('over'); }
    else {
      chip.textContent = `T${v.present} · ${v.player ? 'Black' : 'White'} to move${v.checks.length ? ' · in check' : ''}`;
      if (v.checks.length) chip.classList.add('check');
    }
  }

  renderMoves() {
    const box = $('#og-moves');
    if (!this.tree || !this.tree.nodes[0].children.length) {
      box.replaceChildren(el('div', { class: 'moves-empty', text: 'No actions yet.' }));
      return;
    }
    const rows = [];
    let row = null;
    const rootBlack = this.rules.call({ cmd: 'view', node: 0, draft: [] }).view.player;
    for (let c = 0; this.tree.nodes[c].children.length;) {
      c = this.tree.nodes[c].children[this.tree.nodes[c].children.length - 1];
      const n = this.tree.nodes[c];
      const k = n.ply - 1 + rootBlack;
      const black = k % 2 === 1;
      if (!row || !black) {
        row = el('div', { class: 'mv-row' }, el('div', { class: 'mv-num', text: Math.floor(k / 2) + 1 + '.' }));
        rows.push(row);
        if (black) row.append(el('div', { class: 'mv empty', text: '…' }));
      }
      const pending = this.pending && n.ply > this.pending.ply;
      row.append(el('div', { class: 'mv' + (c === this.cur ? ' cur' : '') + (pending ? ' pending' : ''), dataset: { id: c }, title: n.lan }, moveText(n) || n.lan));
      if (black) row = null;
    }
    box.replaceChildren(...rows);
    const cur = box.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  goto(id) {
    const n = this.tree && this.tree.nodes[id];
    if (!n || id === this.cur) return;
    const forward = n.ply > this.tree.nodes[this.cur].ply;
    this.cur = id;
    this.input.reset();
    this.render();
    if (forward) sounds.action(n.san, { check: false });
  }

  /** Step through the actions: to the first, the previous, the next or the last. */
  step(where) {
    const n = this.tree && this.tree.nodes[this.cur];
    if (!n) return;
    const next = where === 'first' ? 0 : where === 'prev' ? n.parent : where === 'next' ? n.children[n.children.length - 1] : this.lastNode();
    if (next != null) this.goto(next);
  }

  key(e) {
    const k = e.key;
    if (k === 'Enter' || k === 'f' || k === 'F') this.input.submit();
    else if (k === 'Backspace') this.input.undo();
    else if (k === 'Escape') this.input.clear();
    else if (k === 'ArrowLeft') this.step('prev');
    else if (k === 'ArrowRight') this.step('next');
    else if (k === 'Home' || k === 'ArrowUp') this.step('first');
    else if (k === 'End' || k === 'ArrowDown') this.step('last');
    else return false;
    return true;
  }
}

