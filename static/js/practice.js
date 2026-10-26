// Checkmate practice (Learn): the five practice positions of the 5D game, a side with pieces
// against a lone king, played against Kairos defending the king, after infinitechess.org's
// checkmate practice. The games are local (nothing is sent anywhere). A list of the positions
// (in the game's order) covers the board until one is chosen; beating one marks it completed
// (kept in this browser), with a progress bar and badges at 50, 75 and 100 %. In a game: undo
// (your last action and Kairos's reply, once per reply), restart, and back to the list.
import { Rules } from './kairos.js';
import { sounds } from './sound.js';
import { moveText } from './notation.js';
import { $, el, toast, onWindow } from './util.js';

/** The practice positions, in the 5D game's order: id, its variant, and the pieces shown. */
const ALL = [
  { id: 'knight', variant: 'Checkmate Practice - Knight', pieces: ['knight'] },
  { id: 'bishop', variant: 'Checkmate Practice - Bishop', pieces: ['bishop'] },
  { id: 'rook', variant: 'Checkmate Practice - Rook', pieces: ['rook'] },
  { id: 'queen', variant: 'Checkmate Practice - Queen', pieces: ['queen'] },
  { id: 'pawns', variant: 'Checkmate Practice - Pawns', pieces: ['pawn', 'pawn', 'pawn'] },
];

/** Kairos thinks this long on each reply, and never answers sooner (an even pace). */
const REPLY_MS = 500;

const STORAGE_KEY = 'kairos.practiceCompleted';
const EXPIRY_MS = 365 * 24 * 3600 * 1000; // a year from the last completion

const BADGES = [
  { id: 'bronze', threshold: 0.5, name: 'Checkmate Veteran' },
  { id: 'silver', threshold: 0.75, name: 'Checkmate Pro' },
  { id: 'gold', threshold: 1, name: 'Checkmate Master' },
];

/** The checkmates completed in this browser ({value: ids, expires}; gone after a year idle). */
export function completedCheckmates() {
  try {
    const o = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!o || !Array.isArray(o.value) || typeof o.expires !== 'number') return [];
    if (o.expires < Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    return o.value.filter((id) => ALL.some((c) => c.id === id));
  } catch (e) { return []; }
}

function markCompleted(id) {
  const done = completedCheckmates();
  if (!done.includes(id)) done.push(id);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ value: done, expires: Date.now() + EXPIRY_MS })); } catch (e) { /* private mode */ }
}

const RESULT_TEXT = {
  checkmate: (w) => `${w} wins by checkmate.`,
  resignation: (w) => `${w} wins by resignation.`,
  exiled: (w) => `${w} wins: every enemy king is exiled.`,
  stalemate: () => 'Draw by stalemate.',
};

export class Practice {
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.input = app.input;
    this.engine = app.engine;
    this.game = null; // {checkmate, human: 'w'|'b', over: {result, reason, winner}|null}
    this.cur = 0;
    this.undoLegal = false;
    this.searchId = null;
    this.source = {
      mode: 'play',
      rules: null,
      node: () => this.cur,
      canMove: () => this.myTurn(),
      blocked: () => this.blockedHint(),
      submit: (moves) => this.submit(moves),
      onView: (v) => this.onView(v),
    };
    onWindow('notation-change', () => { if (this.game) this.renderMoves(); });
  }

  async init() {
    this.rules = await Rules.create();
    this.source.rules = this.rules;
    this.engine.on((m) => this.onEngine(m));
    this.buildList();
    $('#practice-undo').onclick = () => this.undo();
    $('#practice-restart').onclick = () => this.restart();
    $('#practice-back').onclick = () => this.openList();
    $('#practice-moves').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (c) this.goto(+c.dataset.id);
    });
  }

  // ---------------------------------------------------------------- the list
  buildList() {
    const piece = (name, color, collated) => el('span', { class: 'mate-piece' + (collated ? ' collated' : '') },
      el('img', { src: `pieces/${name}-${color}.svg`, alt: '', draggable: 'false' }));
    const groups = [el('div', { class: 'checkmates' }, ...ALL.map((c) => {
        const human = this.humanColor(c);
        const mine = human === 'w' ? 'white' : 'black', theirs = human === 'w' ? 'black' : 'white';
        const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        check.setAttribute('class', 'mate-check');
        check.setAttribute('viewBox', '0 0 24 24');
        check.innerHTML = '<polyline points="20 6 9 17 4 12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>';
        return el('button', { type: 'button', class: 'checkmate', dataset: { id: c.id }, title: c.variant, onclick: () => this.start(c) },
          el('span', { class: 'mate-pieces mine' }, ...c.pieces.map((p, i) => piece(p, mine, i > 0 && c.pieces[i - 1] === p))),
          el('span', { class: 'mate-versus', text: 'vs' }),
          el('span', { class: 'mate-pieces theirs' }, piece('king', theirs, false)),
          check);
      }))];
    $('#practice-groups').replaceChildren(...groups);
    this.refreshProgress();
  }

  /** The side with the pieces (the one you play): whoever has more than a king. */
  humanColor(c) {
    this.humanMemo = this.humanMemo || new Map();
    if (!this.humanMemo.has(c.id)) {
      let color = 'b';
      try {
        const fen = this.rules.call({ cmd: 'new', position: c.variant }) && this.rules.call({ cmd: 'view', node: 0, draft: [] }).view.boards[0][3];
        const white = (fen.match(/[A-Z]/g) || []).length, black = (fen.match(/[a-z]/g) || []).length;
        color = white > black ? 'w' : 'b';
      } catch (e) { /* the 5D game's practice positions give Black the pieces */ }
      this.humanMemo.set(c.id, color);
    }
    return this.humanMemo.get(c.id);
  }

  refreshProgress() {
    const done = completedCheckmates();
    let n = 0;
    for (const b of document.querySelectorAll('#practice-groups .checkmate')) {
      const beaten = done.includes(b.dataset.id);
      b.classList.toggle('beaten', beaten);
      if (beaten) n++;
    }
    $('#practice-count').textContent = `${n} / ${ALL.length}`;
    $('#practice-fill').style.width = `${(100 * n) / ALL.length}%`;
    for (const badge of BADGES) {
      const need = Math.ceil(badge.threshold * ALL.length);
      const earned = n >= badge.threshold * ALL.length;
      const box = $(`#practice-badge-${badge.id}`);
      box.classList.toggle('earned', earned);
      box.title = earned ? `${badge.name}: completed ${badge.threshold * 100}% of the practice checkmates.`
        : `Complete ${badge.threshold * 100}% of the practice checkmates (${need} of ${ALL.length}) to earn this badge.`;
    }
  }

  openList() {
    this.refreshProgress();
    $('#practice-select').classList.remove('hidden');
  }

  // ---------------------------------------------------------------- page
  activate() {
    this.active = true;
    this.input.attach(this.source);
    if (!this.game) {
      this.openList();
      this.board.setView(this.rules.call({ cmd: 'view', node: this.cur, draft: [] }).view);
    } else {
      this.orient();
      this.show();
      this.resume();
    }
  }

  deactivate() {
    this.active = false;
    // Kairos's reply waits until the page is back (activate resumes it): nothing runs elsewhere.
    this.stopEngine();
  }

  start(c) {
    this.stopEngine();
    const r = this.rules.call({ cmd: 'new', position: c.variant });
    this.tree = r.tree;
    this.cur = 0;
    this.game = { checkmate: c, human: this.humanColor(c), over: null };
    this.undoLegal = false;
    this.input.reset();
    this.board.clearMarks();
    this.board.fitted = false;
    this.orient();
    $('#practice-select').classList.add('hidden');
    $('#practice-title').textContent = c.variant.replace('Checkmate Practice - ', 'Checkmate practice: ');
    if (this.active) sounds.play('start');
    this.afterAction();
  }

  restart() {
    if (this.game) this.start(this.game.checkmate);
  }

  orient() {
    if (!this.active || !this.game) return;
    this.board.setFlipped(this.game.human === 'b');
  }

  view(node = this.cur) { return this.rules.call({ cmd: 'view', node, draft: [] }).view; }

  lastNode() {
    let c = 0;
    while (this.tree.nodes[c].children.length) c = this.tree.nodes[c].children[0];
    return c;
  }

  plies() { return this.tree.nodes[this.lastNode()].ply; }

  toMove(node = this.lastNode()) { return this.view(node).player ? 'b' : 'w'; }

  myTurn() {
    const g = this.game;
    return !!g && !g.over && this.cur === this.lastNode() && this.toMove() === g.human;
  }

  blockedHint() {
    const g = this.game;
    if (!g) toast('Choose a checkmate first');
    else if (g.over) toast('The game is over: undo, restart or go back to the list');
    else if (this.cur !== this.lastNode()) toast('Go to the latest position to move');
    else toast('Kairos is thinking…');
  }

  async submit(moves) {
    const r = this.rules.call({ cmd: 'play', node: this.cur, moves });
    this.tree = r.tree;
    this.cur = r.node;
    sounds.action(this.tree.nodes[r.node].san, { move: false });
    // Your action: undo it alone if it ended the game, else not while Kairos replies.
    this.afterAction();
    if (this.game.over && this.plies() > 0) this.undoLegal = true;
    else if (this.undoLegal && !this.game.over) this.undoLegal = false;
    this.show();
  }

  /** After any action: the game is over, or it is Kairos's turn (it replies) or yours. */
  afterAction() {
    const g = this.game;
    const v = this.view(this.lastNode());
    const over = this.conclusion(v);
    if (over) {
      g.over = over;
      if (over.winner === g.human) markCompleted(g.checkmate.id);
      if (this.active) sounds.end(over.result, g.human);
    } else if (this.toMove() !== g.human) this.think(v.position);
    this.show();
  }

  /** The game's end in view `v` (the side to move there is checkmated, stalemated, ...), or null. */
  conclusion(v) {
    const toMove = v.player ? 'b' : 'w', other = toMove === 'w' ? 'b' : 'w';
    const win = (w, reason) => ({ result: w === 'w' ? '1-0' : '0-1', reason, winner: w });
    if (v.status === 'checkmate') return win(other, 'checkmate');
    if (v.status === 'exiled-white') return win('b', 'exiled');
    if (v.status === 'exiled-black') return win('w', 'exiled');
    if (v.status === 'stalemate') return { result: '1/2-1/2', reason: 'stalemate', winner: null };
    return null;
  }

  // ---------------------------------------------------------------- Kairos
  async think(position) {
    const g = this.game;
    this.thinkingFor = { g, node: this.lastNode(), since: performance.now() };
    const p = this.engine.search({ position, movetime: REPLY_MS, skillLevel: 8, book: false, newGame: this.plies() === 0 });
    this.searchId = this.engine.reqId;
    try {
      await p;
    } catch (e) {
      if (this.game === g) toast('Kairos could not start: ' + e.message, { error: true });
    }
  }

  stopEngine() {
    if (this.searchId != null) this.engine.stop();
    this.searchId = null;
    this.thinkingFor = null;
    clearTimeout(this.replyTimer);
  }

  /** Back on the page with Kairos to move and its search replaced (say by analysis): again. */
  resume() {
    const g = this.game;
    if (!g || g.over || this.toMove() === g.human) return;
    if (this.searchId != null && this.engine.busy && this.engine.reqId === this.searchId) return;
    if (this.replyTimer && this.thinkingFor) return;
    this.think(this.view(this.lastNode()).position);
  }

  onEngine(m) {
    if (this.searchId == null || m.id !== this.searchId) return;
    const t = this.thinkingFor;
    if (m.type === 'error') {
      this.searchId = null;
      toast('Kairos stopped: ' + m.message, { error: true });
      return;
    }
    if (m.type !== 'done') return;
    this.searchId = null;
    if (!t || t.g !== this.game || t.node !== this.lastNode()) return;
    // The reply waits out the full think time, for an even pace.
    const wait = Math.max(0, REPLY_MS - (performance.now() - t.since));
    this.replyTimer = setTimeout(() => this.reply(t, m.bestmove), wait);
  }

  reply(t, bestmove) {
    this.replyTimer = null;
    this.thinkingFor = null;
    const g = this.game;
    if (t.g !== g || t.node !== this.lastNode() || g.over) return;
    if (!bestmove) {
      // No action at all: Kairos gives up (as infinitechess counts a silent engine as resigning).
      g.over = { result: g.human === 'w' ? '1-0' : '0-1', reason: 'resignation', winner: g.human };
      markCompleted(g.checkmate.id);
      if (this.active) sounds.end(g.over.result, g.human);
      this.show();
      return;
    }
    let r;
    try {
      r = this.rules.call({ cmd: 'play', node: t.node, lan: bestmove });
    } catch (e) {
      toast('Kairos played an illegal action: ' + e.message, { error: true });
      return;
    }
    const atEnd = this.cur === t.node;
    this.tree = r.tree;
    if (atEnd) this.cur = r.node;
    if (this.active && atEnd) sounds.action(this.tree.nodes[r.node].san);
    this.afterAction();
    if (!this.undoLegal && this.plies() > 1) this.undoLegal = true;
    this.show();
  }

  // ---------------------------------------------------------------- undo
  /**
   * Take back your last action and Kairos's reply (once per reply), or only your action when it
   * ended the game. Always from the latest position.
   */
  undo() {
    const g = this.game;
    if (!g || !this.undoLegal || this.plies() === 0) return;
    const yours = !g.over && this.toMove() === g.human;
    if (!yours && !g.over) return;
    this.undoLegal = false;
    this.stopEngine();
    let node = this.lastNode();
    const back = () => {
      const parent = this.tree.nodes[node].parent;
      this.tree = this.rules.call({ cmd: 'delete', node }).tree;
      node = parent;
    };
    if (yours && this.plies() > 1) back();
    back();
    g.over = null;
    this.cur = node;
    this.input.reset();
    // Kairos to move after the take-back (its own action ended the game): it replies again.
    if (this.toMove() !== g.human) this.think(this.view(node).position);
    this.show();
  }

  goto(id) {
    const n = this.tree && this.tree.nodes[id];
    if (!n || id === this.cur) return;
    const forward = n.ply > this.tree.nodes[this.cur].ply;
    this.cur = id;
    this.input.reset();
    this.show();
    if (forward) sounds.action(n.san, { check: false });
  }

  // ---------------------------------------------------------------- drawing
  show() {
    if (!this.active || !this.game) return;
    const g = this.game;
    const toMove = this.toMove();
    $('#practice-top-name').textContent = 'Kairos';
    $('#practice-bottom-name').textContent = 'You';
    $('#practice-top').classList.toggle('tempo', !g.over && toMove !== g.human);
    $('#practice-bottom').classList.toggle('tempo', !g.over && toMove === g.human);
    $('#practice-status').textContent = g.over ? '' : toMove === g.human ? 'Your move: checkmate the king' : 'Kairos is thinking…';
    $('#practice-status').classList.toggle('yours', !g.over && toMove === g.human);
    const res = $('#practice-result');
    res.classList.toggle('hidden', !g.over);
    if (g.over) {
      const who = g.over.winner === 'w' ? 'White' : 'Black';
      $('#practice-result-score').textContent = g.over.result.replace('1/2-1/2', '½-½');
      $('#practice-result-text').textContent = RESULT_TEXT[g.over.reason](who);
    }
    $('#practice-undo').disabled = !this.undoLegal;
    this.board.setOverlay({ readonly: !this.myTurn(), pv: [] });
    this.renderMoves();
    try { this.input.refresh(true); } catch (e) { toast(e.message, { error: true }); }
    $('#eval-bar').classList.add('hidden');
  }

  onView(v) {
    const chip = $('#status-chip');
    chip.className = 'status-line';
    if (v.status === 'checkmate') { chip.textContent = `Checkmate · ${v.player ? 'White' : 'Black'} wins`; chip.classList.add('over'); }
    else if (v.status === 'stalemate') { chip.textContent = 'Stalemate · draw'; chip.classList.add('over'); }
    else {
      chip.textContent = `T${v.present} · ${v.player ? 'Black' : 'White'} to move${v.checks.length ? ' · in check' : ''}`;
      if (v.checks.length) chip.classList.add('check');
    }
  }

  renderMoves() {
    const box = $('#practice-moves');
    if (!this.tree || this.tree.nodes.length < 2 || !this.tree.nodes[0].children.length) {
      box.replaceChildren(el('div', { class: 'moves-empty', text: 'No actions yet.' }));
      return;
    }
    const rows = [];
    let row = null;
    const rootBlack = this.view(0).player;
    for (let c = 0; this.tree.nodes[c].children.length;) {
      c = this.tree.nodes[c].children[0];
      const n = this.tree.nodes[c];
      const k = n.ply - 1 + rootBlack;
      const black = k % 2 === 1;
      if (!row || !black) {
        row = el('div', { class: 'mv-row' }, el('div', { class: 'mv-num', text: Math.floor(k / 2) + 1 + '.' }));
        rows.push(row);
        if (black) row.append(el('div', { class: 'mv empty', text: '…' }));
      }
      row.append(el('div', { class: 'mv' + (c === this.cur ? ' cur' : ''), dataset: { id: c }, title: n.lan }, moveText(n) || n.lan));
      if (black) row = null;
    }
    box.replaceChildren(...rows);
    const cur = box.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  key(e) {
    const k = e.key;
    if (k === 'Enter' || k === 'f' || k === 'F') this.input.submit();
    else if (k === 'Backspace') this.input.undo();
    else if (k === 'Escape') this.input.clear();
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const n = this.tree && this.tree.nodes[this.cur];
      if (!n) return false;
      const next = k === 'ArrowLeft' ? n.parent : n.children[0];
      if (next != null) this.goto(next);
    } else return false;
    return true;
  }
}
