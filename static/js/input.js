// Building an action on the board: select a piece, click a target, repeat on every board you
// must (or want to) play, then submit. Shared by the analysis board and play mode.
import { $, el, toast, store, onWindow } from './util.js';
import { sounds } from './sound.js';
import { moveText } from './notation.js';

/** Promotion letters (as the rules core's) to the names of their piece images. */
const PROMO_NAMES = { Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', U: 'unicorn', D: 'dragon', S: 'princess', C: 'commonking' };

export class MoveInput {
  constructor(board) {
    this.board = board;
    this.source = null; // {rules, node, canMove(), submit(moves), onView(view)}
    this.draft = [];
    this.selected = null;
    this.targets = [];
    // Auto-submit (toolbar) sends a lone action as soon as nothing else can be played. It is
    // on by default on the analysis board, where a move is easily taken back, and off in play
    // and puzzles, where, as in the Steam game, every action waits for Submit. Remembered per
    // page.
    this.autoSubmitBy = { analysis: true, play: false, puzzle: false, ...(store('autoSubmitBy') || {}) };
    this.peek = false;
    board.onSquare = (sq) => this.click(sq);
    // A right-click with a piece selected only deselects it (as 5dcol); otherwise it draws.
    board.onRightPress = () => {
      if (!this.selected) return false;
      this.deselect();
      return true;
    };
    $('#tool-autosubmit').onclick = () => {
      this.autoSubmitBy[this.mode] = !this.autoSubmit;
      store('autoSubmitBy', this.autoSubmitBy);
      this.showAutoSubmit();
      toast(this.autoSubmit ? 'Auto-submit on' : 'Auto-submit off: press Submit (F or Enter) after each action');
    };
    this.showAutoSubmit();
    onWindow('notation-change', () => { if (this.draft.length && this.source) this.renderBar(this.view()); });
    $('#draft-undo').onclick = () => this.undo();
    $('#draft-reset').onclick = () => this.clear();
    $('#draft-submit').onclick = () => this.submit();
  }

  get mode() { return (this.source && this.source.mode) || 'analysis'; }
  get autoSubmit() { return !!this.autoSubmitBy[this.mode]; }

  showAutoSubmit() {
    const tool = $('#tool-autosubmit');
    const where = this.mode === 'play' ? 'in play' : this.mode === 'puzzle' ? 'in puzzles' : 'on the analysis board';
    tool.classList.toggle('on', this.autoSubmit);
    tool.title = this.autoSubmit
      ? `Auto-submit is on ${where}: an action is sent once nothing else can be played (click to turn off)`
      : `Auto-submit is off ${where}: press Submit, F or Enter after every action, like the Steam game (click to turn on)`;
  }

  /** Attach to a game source; resets any action in progress. */
  attach(source) {
    this.source = source;
    this.showAutoSubmit();
    this.reset();
  }

  reset() {
    this.closePromotion();
    this.draft = [];
    this.selected = null;
    this.targets = [];
    this.peek = false;
    this.board.setOverlay({ selected: null, targets: [], targetColor: null, peek: false });
    this.renderBar(null);
  }

  get active() { return this.draft.length > 0; }

  /**
   * The current position (with the draft applied), from the rules core. A draft that no longer
   * fits the position (the tree changed under it) is dropped rather than left to fail every
   * redraw.
   */
  view() {
    const s = this.source;
    try {
      return s.rules.call({ cmd: 'view', node: s.node(), draft: this.draft }).view;
    } catch (e) {
      if (!this.draft.length) throw e;
      this.draft = [];
      this.selected = null;
      this.targets = [];
      this.peek = false;
      this.board.setOverlay({ selected: null, targets: [], targetColor: null, peek: false });
      return s.rules.call({ cmd: 'view', node: s.node(), draft: [] }).view;
    }
  }

  refresh(follow = true) {
    const v = this.view();
    this.board.setView(v, { follow });
    this.renderBar(v);
    renderTimelines(v);
    if (this.source.onView) this.source.onView(v, this.draft);
    return v;
  }

  /**
   * A click on the board: select one of your pieces on a playable board and move it, or
   * click any other piece on a board of its own colour (an opponent's piece on a board your
   * action just made, say) to see where it could go. Seeing moves never plays anything.
   */
  click(sq) {
    const s = this.source;
    if (!s) return;
    if (!sq) return this.deselect();
    const canMove = s.canMove();
    if (this.selected && !this.peek && canMove) {
      const tgt = this.targets.find((t) => t[0] === sq.l && t[1] === sq.t && t[2] === sq.x && t[3] === sq.y && sq.c === this.board.view.player);
      if (tgt) return this.move(this.selected, tgt);
    }
    const from = [sq.l, sq.t, sq.x, sq.y];
    if (this.selected && this.selected.l === sq.l && this.selected.v === sq.v && this.selected.x === sq.x && this.selected.y === sq.y) return this.deselect();
    const own = canMove && this.board.isInteresting(sq);
    const peek = !own && this.board.isPeekable(sq);
    if (!own && !peek) {
      if (!canMove && s.blocked && this.board.isInteresting(sq)) s.blocked();
      return this.deselect();
    }
    let targets = [];
    try {
      const req = { cmd: 'targets', node: s.node(), draft: this.draft, from };
      if (peek) req.color = sq.c;
      targets = s.rules.call(req).targets;
    } catch (e) {
      toast(e.message, { error: true });
    }
    this.selected = { ...sq };
    this.targets = targets;
    this.peek = peek;
    this.board.setOverlay({ selected: this.selected, targets, targetColor: peek ? sq.c : null, peek });
  }

  deselect() {
    this.selected = null;
    this.targets = [];
    this.peek = false;
    this.board.setOverlay({ selected: null, targets: [], targetColor: null, peek: false });
  }

  /**
   * The pieces a pawn or brawn moving `sel` to `tgt` may promote to (letters, the position's
   * promotion set), or none when the move does not promote.
   */
  promotionOptions(sel, tgt) {
    const v = this.board.view;
    const pc = this.board.pieceAt(sel);
    if (!v || !pc || !v.promotions || !/^[pw]$/i.test(pc.p)) return [];
    const last = v.player ? 0 : v.size[1] - 1;
    return tgt[3] === last ? [...v.promotions] : [];
  }

  /**
   * Ask which piece to promote to, as Lichess does: the choices stacked beside the square, the
   * rest of the board dimmed. Resolves to a piece letter, or null when dismissed (a click
   * elsewhere, Escape).
   */
  askPromotion(tgt, options) {
    this.closePromotion();
    const v = this.board.view;
    const area = $('#board-area');
    const color = v.player ? 'black' : 'white';
    return new Promise((resolve) => {
      const done = (p) => this.closePromotion(p);
      const buttons = options.map((p) => el('button', {
        type: 'button', class: 'promo-choice', title: `${PROMO_NAMES[p][0].toUpperCase() + PROMO_NAMES[p].slice(1)} (${p})`,
        onclick: (e) => { e.stopPropagation(); done(p); },
      }, el('img', { src: `pieces/${PROMO_NAMES[p]}-${color}.svg`, alt: PROMO_NAMES[p], draggable: 'false' })));
      const pick = el('div', { class: 'promo-pick', role: 'dialog', 'aria-label': 'Promote to' }, ...buttons);
      pick.style.gridTemplateRows = `repeat(${Math.min(4, options.length)}, var(--promo-size))`;
      const scrim = el('div', { class: 'promo-scrim', onclick: () => done(null) }, pick);
      area.append(scrim);
      // Beside the target square when that board is drawn (else in the middle), kept inside.
      const b = this.board;
      let x = b.w / 2, y = b.h / 2;
      if (b.boards.has(`${tgt[0]},${2 * tgt[1] + v.player}`)) {
        [x, y] = b.toScreen(...b.squareCenter(tgt[0], 2 * tgt[1] + v.player, tgt[2], tgt[3]));
      }
      const r = pick.getBoundingClientRect();
      pick.style.left = Math.max(4, Math.min(x - r.width / 2, b.w - r.width - 4)) + 'px';
      pick.style.top = Math.max(4, Math.min(y - r.height / 2, b.h - r.height - 4)) + 'px';
      const key = (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const p = e.key.length === 1 ? e.key.toUpperCase() : '';
        if (e.key === 'Escape') done(null);
        else if (options.includes(p)) done(p);
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      document.addEventListener('keydown', key, true);
      this.promo = { scrim, key, resolve };
    });
  }

  /** Take the promotion choice down, answering it with `piece` (none when dismissed). */
  closePromotion(piece = null) {
    const p = this.promo;
    if (!p) return;
    this.promo = null;
    document.removeEventListener('keydown', p.key, true);
    p.scrim.remove();
    p.resolve(piece);
  }

  move(sel, tgt) {
    const options = this.promotionOptions(sel, tgt);
    if (options.length < 2) return this.play(sel, tgt);
    this.askPromotion(tgt, options).then((p) => { if (p) this.play(sel, tgt, p); });
  }

  /** Add the move to the action (with the piece chosen to promote to, if it promotes). */
  play(sel, tgt, promote) {
    const s = this.source;
    const mv = { from: [sel.l, sel.t, sel.x, sel.y], to: tgt };
    if (promote) mv.promote = promote;
    try {
      s.rules.call({ cmd: 'check_move', node: s.node(), draft: this.draft, move: mv });
    } catch (e) {
      toast(e.message, { error: true });
      return;
    }
    this.draft.push(mv);
    this.deselect();
    // Playing a move clears the user's marks (as lichess).
    this.board.clearMarks();
    const v = this.refresh();
    sounds.action(v.draftSan?.[this.draft.length - 1] || '', { check: false });
    // A lone action (nothing else left to play) submits itself.
    const morePlayable = v.timelines.some((tl) => tl.end[1] === v.player && tl.status !== 'unplayable');
    if (this.autoSubmit && v.canSubmit && !morePlayable) this.submit();
  }

  undo() {
    if (!this.draft.length) return;
    this.draft.pop();
    this.deselect();
    this.refresh();
  }

  clear() {
    if (!this.draft.length) return this.deselect();
    this.draft = [];
    this.deselect();
    this.refresh();
  }

  /**
   * Submit the action once. The draft is cleared before the source applies it: the source
   * (and any state update arriving meanwhile) redraws the new position, which must not
   * replay the submitted moves on top of it.
   */
  async submit() {
    if (!this.draft.length || this.submitting) return;
    const moves = this.draft.slice();
    const node = this.source.node();
    this.submitting = true;
    this.draft = [];
    this.deselect();
    this.renderBar(null);
    try {
      await this.source.submit(moves);
    } catch (e) {
      toast(e.message, { error: true });
      // Rejected before the position changed: give the moves back to keep editing.
      if (this.source.node() === node) {
        this.draft = moves;
        try { this.refresh(false); } catch (err) { this.reset(); }
      }
    } finally {
      this.submitting = false;
    }
  }

  renderBar(v) {
    const bar = $('#draft-bar');
    if (!this.draft.length || !v) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    const moves = $('#draft-moves');
    const san = v.draftSan || [];
    moves.replaceChildren(...this.draft.map((m, i) => el('span', { class: 'chip', title: lanText(m), text: moveText({ san: san[i], sanFull: (v.draftSanFull || [])[i], lone: v.lone }) || lanText(m) })));
    const hint = $('#draft-hint');
    $('#draft-submit').disabled = !v.canSubmit;
    if (v.canSubmit) {
      hint.textContent = 'Ready: Submit (F or Enter), or keep playing other boards. Click any piece to see its moves.';
      hint.classList.remove('bad');
    } else {
      hint.textContent = v.submitError ? cap(v.submitError) : '';
      hint.classList.toggle('bad', !!v.submitError && !/every board on the present/.test(v.submitError));
      if (/every board on the present/.test(v.submitError || '')) hint.textContent = 'Play a move on every highlighted board on the present, then submit.';
    }
  }
}

/**
 * The present and timeline advantage, as in the Steam game, in the side panels (`.tl-line`):
 * the present turn, the timelines each side has created, who leads, and how many are inactive
 * (or whether a new timeline by the side to move would be active: a side may lead the other by
 * one active timeline; further ones are inactive).
 */
export function renderTimelines(v) {
  const lines = document.querySelectorAll('.tl-line');
  if (!v) return lines.forEach((n) => n.replaceChildren());
  const side = v.player ? 'Black' : 'White';
  const white = v.lines[1] - v.initialLines[1];
  const black = v.initialLines[0] - v.lines[0];
  const inactive = (v.active[0] - v.lines[0]) + (v.lines[1] - v.active[1]);
  const lead = white - black;
  const mine = v.player ? black : white, theirs = v.player ? white : black;
  const next = mine <= theirs ? 'active' : 'inactive';
  const parts = () => {
    const out = [el('span', { title: 'The present: the earliest turn among the active timelines. Every active board on it must be played.' }, el('b', { text: `Present T${v.present}` }))];
    if (white || black || inactive) {
      out.push(el('span', { title: `Timelines created: White ${white}, Black ${black}. A side may lead by one active timeline. A new timeline by ${side} now would be ${next}.` },
        `Timelines W ${white} · B ${black} · `, el('b', { text: lead > 0 ? `White +${lead}` : lead < 0 ? `Black +${-lead}` : 'even' }),
        inactive ? ` · ${inactive} inactive` : ` · next ${side} timeline ${next}`));
    }
    return out;
  };
  lines.forEach((n) => n.replaceChildren(...parts()));
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

const files = 'abcdefgh';
export function lanText(m) {
  const sq = (p) => files[p[2]] + (p[3] + 1);
  const a = `(${m.from[0]}T${m.from[1]})${sq(m.from)}`;
  const same = m.from[0] === m.to[0] && m.from[1] === m.to[1];
  return (same ? a + sq(m.to) : `${a}(${m.to[0]}T${m.to[1]})${sq(m.to)}`) + (m.promote || '');
}
