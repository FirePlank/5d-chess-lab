// Puzzles, after lichess's puzzle trainer. #/puzzles/themes (where the Puzzles tab goes) is the
// dashboard: your rating, the themes with what is left in each, the filters, and your latest
// puzzles. #/puzzles?new=1 opens a puzzle at once (around your puzzle rating, in the chosen
// theme and rating range, one you have not played); #/puzzles/<id> is that puzzle.
//
// The puzzles are Kairos's (puzzlegen's site export, in public.puzzles). Each solver step says
// how its answers are judged: "keys" (any action with all the key moves is right), "list" (only
// the line's action and the listed variants, or, when the list is incomplete, what Kairos finds
// keeps the result), "mates" (any mate). Off the stored line (after a variant that changes what
// follows, or an answer Kairos judged), Kairos in the browser judges the following answers and
// plays the replies. Any checkmate wins. A wrong action is taken back after a moment; the first
// one loses the puzzle (rated once, as lichess), and you can still finish it. A hint shows the
// square to move from (a second one the move) and makes the round unrated; the solution plays
// the line out on the board.
import { Rules } from './kairos.js';
import { sounds } from './sound.js';
import { moveText } from './notation.js';
import { lanText } from './input.js';
import { rpc, sb } from './net.js';
import { $, el, toast, store, parseLan, onWindow } from './util.js';

/** The themes (puzzlegen's tags): name, description, group. */
export const THEMES = {
  mate: ['Checkmate', 'Win the game with style.', 'goal'],
  matingAttack: ['Mating attack', 'Attack the king: a mate is coming, but the puzzle ends before it.', 'goal'],
  advantage: ['Advantage', 'Seize your chance to get a decisive advantage.', 'goal'],
  defensiveMove: ['Defensive move', 'A precise action that holds a worse position.', 'goal'],
  onlyMove: ['Only move', 'Exactly one idea holds; everything else loses.', 'goal'],
  mateIn1: ['Mate in 1', 'Deliver checkmate in one action.', 'mates'],
  mateIn2: ['Mate in 2', 'Deliver checkmate in two actions.', 'mates'],
  mateIn3: ['Mate in 3', 'Deliver checkmate in three actions.', 'mates'],
  mateIn4: ['Mate in 4', 'Deliver checkmate in four actions.', 'mates'],
  mateIn5plus: ['Mate in 5 or more', 'Work out a long mating sequence.', 'mates'],
  boardMate: ['Mate on the board', 'Checkmate by pieces on the king\'s own board.', 'mates'],
  crossBoardMate: ['Mate across boards', 'Checkmate by a piece on another board or timeline.', 'mates'],
  timeTravel: ['Time travel', 'A key move travels into the past.', '5d'],
  branchingTravel: ['Branching travel', 'A key move travels into the past and branches off a new timeline.', '5d'],
  timelineJump: ['Timeline jump', 'A key move jumps to another timeline at the same time.', '5d'],
  newTimeline: ['New timeline', 'The solution creates a new timeline.', '5d'],
  crossBoardCheck: ['Check across boards', 'A check from another board or timeline.', '5d'],
  multiBoard: ['Combination over boards', 'Two or more key moves in one action, on different boards.', '5d'],
  check: ['Check', 'A key action gives check.', 'tactics'],
  capture: ['Capture', 'A key move takes a piece.', 'tactics'],
  fork: ['Fork', 'One piece attacks two or more at once.', 'tactics'],
  hangingPiece: ['Hanging piece', 'An enemy piece is left undefended: take it.', 'tactics'],
  sacrifice: ['Sacrifice', 'Give up material now to gain more a few actions later.', 'tactics'],
  bigSacrifice: ['Big sacrifice', 'Give up a piece or more.', 'tactics'],
  quietMove: ['Quiet move', 'A key move that neither checks nor takes, but prepares a threat that cannot be stopped.', 'tactics'],
  promotion: ['Promotion', 'Promote a pawn.', 'tactics'],
  oneTimeline: ['One timeline', 'Everything happens on a single timeline.', 'timelines'],
  twoTimelines: ['Two timelines', 'Two active timelines to keep track of.', 'timelines'],
  manyTimelines: ['Many timelines', 'Three or more active timelines.', 'timelines'],
  oneMove: ['One-move puzzle', 'A single action to find.', 'length'],
  short: ['Short puzzle', 'Two actions to find.', 'length'],
  long: ['Long puzzle', 'Three or four actions to find.', 'length'],
  veryLong: ['Very long puzzle', 'Five actions or more.', 'length'],
};

export const GROUPS = [
  ['goal', 'Goals'],
  ['mates', 'Mates'],
  ['5d', 'Time and timelines'],
  ['tactics', 'Motifs'],
  ['timelines', 'Board count'],
  ['length', 'Length'],
];

export const DIFFICULTIES = [
  ['easiest', 'Easiest', -600],
  ['easier', 'Easier', -300],
  ['normal', 'Normal', 0],
  ['harder', 'Harder', 300],
  ['hardest', 'Hardest', 600],
];

export const themeName = (t) => (t ? (THEMES[t] || [t])[0] : 'Healthy mix');
export const themeDesc = (t) => (t ? (THEMES[t] || [t, ''])[1] : 'A bit of everything, near your rating.');

/** The trainer's filters, kept in this browser: theme (null: all), difficulty, rating range, replays. */
export function puzzleFilter() {
  const f = { theme: null, difficulty: 'normal', min: null, max: null, replay: false, ...(store('puzzleFilter') || {}) };
  if (f.theme && !THEMES[f.theme]) f.theme = null;
  if (!DIFFICULTIES.some((d) => d[0] === f.difficulty)) f.difficulty = 'normal';
  return f;
}

export function setPuzzleFilter(changes) {
  const f = { ...puzzleFilter(), ...changes };
  store('puzzleFilter', f);
  window.dispatchEvent(new Event('puzzle-filter-change'));
  return f;
}

/** The arguments of puzzle_next for the filter. */
function nextArgs(f, skip) {
  const offset = (DIFFICULTIES.find((d) => d[0] === f.difficulty) || DIFFICULTIES[2])[2];
  return { p_theme: f.theme, p_min: f.min, p_max: f.max, p_offset: offset, p_skip: skip, p_replay: !!f.replay };
}

/** This session's puzzles (lichess's round history): {id, win, diff}, newest last; an idle hour ends it. */
const SESSION_KEY = 'puzzleSession';
export function puzzleSession() {
  const s = store(SESSION_KEY);
  if (!s || !Array.isArray(s.rounds) || Date.now() - (s.at || 0) > 3600_000) return [];
  return s.rounds;
}
function pushSession(round) {
  const rounds = puzzleSession().filter((r) => r.id !== round.id);
  rounds.push(round);
  store(SESSION_KEY, { at: Date.now(), rounds: rounds.slice(-60) });
}

/** The moves of an action as a set key, so that the order of its moves does not matter. */
const actionKey = (lan) => lan.trim().split(/\s+/).sort().join(' ');

const REPLY_MS = 500;      // the defender's reply comes this long after a right action
const WRONG_MS = 600;      // a wrong action stays this long before it is taken back
const JUDGE_MS = 1500;     // Kairos's think when it judges an answer off the stored line
const ENGINE_REPLY_MS = 1000;
const WON_CP = 300;        // puzzlegen's thresholds (reported scale): a win, and holding
const HOLD_FLOOR = -120;

const FEEDBACK = {
  play: (p) => ['Your turn', `Find the best move for ${p.side === 'white' ? 'White' : 'Black'}.`],
  good: () => ['Best move!', 'Keep going…'],
  fail: () => ['That\'s not the move!', 'Try something else.'],
  judge: () => ['Checking…', 'Kairos is looking at your move.'],
  reply: () => ['Best move!', 'Keep going…'],
  win: () => ['Puzzle success!', ''],
  done: () => ['Puzzle complete!', ''],
  view: () => ['Solution', 'Step through it with the arrows, or the moves below.'],
};

export class Puzzles {
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.input = app.input;
    this.engine = app.engine;
    this.s = null;        // the puzzle being solved (see load)
    this.prefetch = null; // {key, promise} of the next puzzle
    this.source = {
      mode: 'puzzle',
      rules: null,
      node: () => (this.s ? this.s.cur : 0),
      canMove: () => this.myTurn(),
      blocked: () => this.blockedHint(),
      submit: (moves) => this.submit(moves),
      onView: (v) => this.onView(v),
    };
    onWindow('notation-change', () => { if (this.s) this.renderMoves(); });
    onWindow('puzzle-filter-change', () => { this.prefetch = null; if (this.active) this.renderTop(); });
  }

  async init() {
    this.rules = await Rules.create();
    this.source.rules = this.rules;
    this.engine.on((m) => this.onEngine(m));
    $('#pz-hint').onclick = () => this.hint();
    $('#pz-solution').onclick = () => this.viewSolution();
    $('#pz-next').onclick = () => this.next();
    $('#pz-retry').onclick = () => this.retry();
    $('#pz-empty-retry').onclick = () => this.next({ replace: true });
    $('#pz-difficulty').replaceChildren(...DIFFICULTIES.map(([id, name]) => el('option', { value: id, text: name })));
    $('#pz-difficulty').onchange = (e) => setPuzzleFilter({ difficulty: e.target.value });
    $('#pz-moves').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (c) this.goto(+c.dataset.id);
    });
    $('#pz-session').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-id]');
      if (a && this.s && a.dataset.id === this.s.p.id) e.preventDefault();
    });
  }

  // ---------------------------------------------------------------- page
  activate(params) {
    this.active = true;
    this.input.attach(this.source);
    this.renderTop();
    this.renderSession();
    const id = params.get('id');
    if (id && this.s && this.s.p.id === id) {
      this.orient();
      this.show();
      return;
    }
    if (id) this.open(id);
    else this.next({ replace: true });
  }

  deactivate() {
    this.active = false;
    this.stopEngine();
    $('#board').classList.remove('pz-hidden');
    this.board.setOverlay({ hint: [], pv: [] });
  }

  /** Puzzle `id` (a link, the session list, the browser's back button). */
  async open(id) {
    this.loading(true);
    try {
      const p = await rpc('puzzle_get', { p_id: id });
      if (!p) {
        toast('That puzzle does not exist.', { error: true });
        return this.next({ replace: true });
      }
      this.load(p);
    } catch (e) {
      this.unavailable(e);
    }
  }

  /** The next puzzle for the filter (the one fetched ahead when it is still for this filter). */
  async next({ replace = false } = {}) {
    this.stopEngine();
    const f = puzzleFilter();
    this.loading(true);
    try {
      const p = await this.fetchNext(f);
      if (!p) return this.empty(f);
      this.load(p);
      const url = `#/puzzles/${p.id}`;
      if (replace) history.replaceState(null, '', url);
      else if (location.hash !== url) history.pushState(null, '', url);
    } catch (e) {
      this.unavailable(e);
    }
  }

  fetchNext(f, ahead = false) {
    const skip = puzzleSession().map((r) => r.id);
    if (this.s) skip.push(this.s.p.id);
    const key = JSON.stringify(nextArgs(f, []));
    if (!ahead && this.prefetch && this.prefetch.key === key) {
      const pre = this.prefetch.promise;
      this.prefetch = null;
      return pre.then((p) => (p && !skip.includes(p.id) ? p : rpc('puzzle_next', nextArgs(f, skip))));
    }
    const promise = rpc('puzzle_next', nextArgs(f, skip));
    if (ahead) {
      this.prefetch = { key, promise };
      promise.catch(() => { if (this.prefetch && this.prefetch.promise === promise) this.prefetch = null; });
    }
    return promise;
  }

  loading(on) {
    $('#side-puzzle').classList.toggle('loading', on);
    $('#board').classList.toggle('pz-hidden', on);
    if (on) $('#pz-empty').classList.add('hidden');
  }

  unavailable(e) {
    this.loading(false);
    this.s = null;
    this.showEmpty('Puzzles are not available right now', e && e.message ? e.message : 'Please try again in a moment.');
  }

  empty(f) {
    this.loading(false);
    this.s = null;
    const range = f.min != null || f.max != null ? ` rated ${f.min ?? '…'}–${f.max ?? '…'}` : '';
    const which = f.theme ? `${themeName(f.theme).toLowerCase()} puzzle` : 'puzzle';
    this.showEmpty('No more puzzles here', `There is no new ${which}${range} for you. Try another theme or range, or include the puzzles you have played.`);
  }

  showEmpty(title, text) {
    $('#pz-empty-title').textContent = title;
    $('#pz-empty-text').textContent = text;
    $('#pz-empty').classList.remove('hidden');
    $('#pz-main').classList.add('hidden');
  }

  /**
   * Start puzzle `p`. State: the line shown (node ids, the root first) and the current node;
   * `step` solver actions done; `book`: the node where the stored line's solver action
   * `bookStep` is due (null once off the line) and whether play is still exactly on it; the
   * mode (play, try after a mistake, view once solved or shown); the result as sent.
   */
  load(p) {
    this.stopEngine();
    const r = this.rules.call({ cmd: 'new', position: p.position });
    this.tree = r.tree;
    this.s = {
      p, solver: p.side === 'white' ? 'w' : 'b', total: Math.ceil(p.solution.length / 2),
      line: [0], cur: 0, step: 0, book: 0, bookStep: 0, exact: true, mode: 'play', failed: false,
      hint: 0, hinted: false, shown: false, sent: null, busy: false, feedback: 'play', started: performance.now(),
    };
    this.input.reset();
    this.board.clearMarks();
    this.board.setOverlay({ hint: [], pv: [] });
    this.board.fitted = false;
    this.orient();
    $('#pz-main').classList.remove('hidden');
    $('#pz-empty').classList.add('hidden');
    this.loading(false);
    this.show();
    // The boards on the present, large (the past is a zoom or a pan away).
    this.board.goPresent(false);
    if (this.active) sounds.play('start');
    clearTimeout(this.solutionTimer);
    // As lichess: the solution is offered after a few seconds (sooner when unrated).
    this.solutionTimer = setTimeout(() => this.show(), 4000);
    // The next one, fetched meanwhile.
    this.fetchNext(puzzleFilter(), true);
  }

  orient() {
    if (!this.active || !this.s) return;
    this.board.setFlipped(this.s.solver === 'b');
  }

  view(node = this.s.cur) { return this.rules.call({ cmd: 'view', node, draft: [] }).view; }
  last() { return this.s.line[this.s.line.length - 1]; }
  toMove(node) { return this.view(node).player ? 'b' : 'w'; }

  myTurn() {
    const s = this.s;
    return !!s && s.mode !== 'view' && !s.busy && s.cur === this.last() && this.toMove(s.cur) === s.solver;
  }

  blockedHint() {
    const s = this.s;
    if (!s) return;
    if (s.mode === 'view') toast('The puzzle is over: continue training, or open it on the analysis board');
    else if (s.cur !== this.last()) toast('Go to the latest position to move');
    else if (s.busy) toast('One moment…');
  }

  // ---------------------------------------------------------------- solving
  async submit(moves) {
    const s = this.s;
    if (!this.myTurn()) return;
    const lan = moves.map(lanText).join(' ');
    const r = this.rules.call({ cmd: 'play', node: s.cur, moves });
    this.tree = r.tree;
    s.line.push(r.node);
    s.cur = r.node;
    this.board.setOverlay({ hint: [], pv: [] });
    s.hint = 0;
    sounds.action(this.tree.nodes[r.node].san, { move: false });
    s.busy = true;
    s.feedback = 'judge';
    this.show();
    let verdict;
    try {
      verdict = await this.judge(lan, r.node);
    } catch (e) {
      if (this.s !== s || s.mode === 'view') return;
      toast('Could not check the move: ' + e.message, { error: true });
      verdict = { ok: false };
    }
    if (this.s !== s || s.mode === 'view') return;
    if (!verdict.ok) return this.wrong(r.node);
    s.step++;
    if (verdict.offBook) s.book = null;
    if (verdict.done) return this.solved();
    if (!verdict.exact) s.exact = false;
    s.feedback = 'good';
    this.show();
    setTimeout(() => this.reply(s, r.node, verdict.reply), REPLY_MS);
  }

  /**
   * Whether action `lan` (played to `node`) is right: {ok, reply (the defender's, null for
   * Kairos's), offBook, exact, done}.
   */
  async judge(lan, node) {
    const s = this.s, p = s.p;
    const v = this.view(node);
    const last = s.step + 1 >= s.total;
    if (v.status === 'checkmate') return { ok: true, done: true };
    if (v.status === 'stalemate') return { ok: p.outcome === 'hold', done: true };
    const st = s.book != null ? p.steps[s.step] : null;
    if (!st) return this.engineJudge(node, last);
    const k = actionKey(lan);
    if (actionKey(st.canonical) === k) return { ok: true, reply: st.reply, exact: s.exact, done: last || !st.reply };
    const variant = (st.variants || []).find((x) => actionKey(x.action) === k);
    if (variant) return { ok: true, reply: variant.reply, exact: false, offBook: variant.same_next === false, done: last || !variant.reply };
    if (st.accept === 'mates') return { ok: false };
    const moves = new Set(k.split(' '));
    if (!st.keys.every((m) => moves.has(m))) return { ok: false };
    // Every action with the key moves is right (filler on other boards does not matter), or
    // the list is incomplete, or play is no longer on the exact line the list was made for:
    // Kairos judges.
    if (st.accept === 'keys') return { ok: true, reply: st.reply, exact: false, done: last };
    if (st.complete && s.exact) return { ok: false };
    return this.engineJudge(node, last);
  }

  /** Kairos judges the action played to `node`: it keeps the puzzle's result. */
  async engineJudge(node, last) {
    const s = this.s, p = s.p;
    if (last && p.ends_in_mate) return { ok: false };
    const res = await this.search(this.view(node).position, JUDGE_MS);
    // The score is the defender's (to move): the solver's is its negation.
    const left = s.total - s.step - 1;
    let ok;
    if (p.outcome === 'hold') ok = res.mate != null ? res.mate < 0 : res.cp != null && -res.cp >= HOLD_FLOOR;
    else if (p.ends_in_mate) ok = res.mate != null && res.mate < 0 && -res.mate <= left;
    else ok = (res.mate != null && res.mate < 0) || (res.cp != null && -res.cp >= WON_CP);
    return { ok, reply: res.bestmove, offBook: true, exact: false, done: last };
  }

  /** The defender's reply `lan` after the solver's action (Kairos's own when none, or it fails). */
  async reply(s, node, lan) {
    if (this.s !== s || s.line[s.line.length - 1] !== node) return;
    let r = null;
    if (lan) {
      try { r = this.rules.call({ cmd: 'play', node, lan }); } catch (e) { r = null; }
    }
    if (!r) {
      s.book = null;
      try {
        const res = await this.search(this.view(node).position, ENGINE_REPLY_MS);
        if (this.s !== s) return;
        if (res.bestmove) r = this.rules.call({ cmd: 'play', node, lan: res.bestmove });
      } catch (e) {
        toast('Kairos could not reply: ' + e.message, { error: true });
      }
    }
    if (this.s !== s) return;
    if (!r) {
      // No reply at all: the defender has nothing left, the puzzle is solved.
      s.busy = false;
      return this.solved();
    }
    this.tree = r.tree;
    const atEnd = s.cur === node;
    s.line.push(r.node);
    if (atEnd) s.cur = r.node;
    if (s.book != null) {
      s.book = r.node;
      s.bookStep = s.step;
    }
    s.busy = false;
    if (this.active && atEnd) sounds.action(this.tree.nodes[r.node].san);
    this.show();
  }

  /** A wrong action: lost (once), shown a moment, then taken back. */
  wrong(node) {
    const s = this.s;
    s.feedback = 'fail';
    if (s.mode === 'play') {
      s.mode = 'try';
      s.failed = true;
      this.send(false);
    }
    this.show();
    setTimeout(() => {
      if (this.s !== s || this.last() !== node) return;
      const parent = this.tree.nodes[node].parent;
      this.tree = this.rules.call({ cmd: 'delete', node }).tree;
      s.line.pop();
      s.cur = parent;
      s.busy = false;
      this.input.reset();
      this.show();
    }, WRONG_MS);
  }

  solved() {
    const s = this.s;
    s.busy = false;
    s.feedback = s.mode === 'play' ? 'win' : 'done';
    if (s.mode === 'play') this.send(true);
    s.mode = 'view';
    if (this.active) sounds.play(s.feedback === 'win' ? 'win' : 'end');
    this.show();
  }

  /**
   * Report the round, once: lost at the first mistake or on viewing the solution, won on
   * solving it without one. As lichess, it is rated unless a hint was shown.
   */
  async send(win) {
    const s = this.s;
    if (s.sent) return;
    const rated = !s.hinted;
    s.sent = { win, rated, pending: true };
    pushSession({ id: s.p.id, win, diff: null });
    this.renderSession();
    try {
      const r = await rpc('puzzle_round', { p_id: s.p.id, p_win: win, p_rated: rated });
      s.sent = { win, rated, ...r };
      pushSession({ id: s.p.id, win, diff: r.diff });
      this.myRating = r.rating;
      if (this.s === s) {
        s.p.rating = r.puzzle_rating;
        if (r.puzzle_plays != null) s.p.plays = r.puzzle_plays;
      }
    } catch (e) {
      s.sent.pending = false;
      toast('Could not save the result: ' + e.message, { error: true });
    }
    this.renderSession();
    if (this.s === s) this.show();
  }

  // ---------------------------------------------------------------- help
  /** A hint (lichess's): the square to move from; asked again, the move. The round is then unrated. */
  async hint() {
    const s = this.s;
    if (!s || s.mode === 'view' || s.busy) return;
    if (s.cur !== this.last()) this.goto(this.last());
    s.hinted = true;
    let move = null;
    const st = s.book != null ? s.p.steps[s.step] : null;
    if (st) move = st.keys && st.keys.length ? st.keys[0] : st.canonical.split(/\s+/)[0];
    else {
      s.busy = true;
      this.show();
      const res = await this.search(this.view(s.cur).position, ENGINE_REPLY_MS).catch(() => ({}));
      if (this.s !== s) return;
      s.busy = false;
      move = res.bestmove ? res.bestmove.split(/\s+/)[0] : null;
    }
    const m = move && parseLan(move);
    if (!m) return this.show();
    s.hint = Math.min(2, s.hint + 1);
    const c = s.solver === 'b' ? 1 : 0;
    this.board.setOverlay({
      hint: [{ l: m.from[0], t: m.from[1], c, x: m.from[2], y: m.from[3] }],
      pv: s.hint > 1 ? [{ from: m.from, to: m.to, c }] : [],
    });
    this.show();
  }

  /** The solution: the stored line played out from where play left it (lichess's "View the solution"). */
  viewSolution() {
    const s = this.s;
    if (!s || s.mode === 'view') return;
    this.stopEngine();
    s.shown = true;
    if (s.mode === 'play') this.send(false);
    s.mode = 'view';
    s.busy = false;
    s.feedback = 'view';
    // From the node where the line's next action is due (a reply on its way is dropped), or
    // from the start when play has left the line.
    const exact = s.book != null && s.exact;
    const from = exact ? s.book : 0;
    let k = exact ? 2 * s.bookStep : 0;
    const at = s.line.indexOf(from);
    s.line = s.line.slice(0, at + 1);
    let node = from;
    try {
      for (; k < s.p.solution.length; k++) {
        const r = this.rules.call({ cmd: 'play', node, lan: s.p.solution[k] });
        this.tree = r.tree;
        node = r.node;
        s.line.push(node);
      }
    } catch (e) {
      toast('Could not play the solution: ' + e.message, { error: true });
    }
    s.cur = s.line[Math.min(s.line.length - 1, at + 1)];
    this.board.setOverlay({ hint: [], pv: [] });
    this.input.reset();
    this.show();
    if (this.active) sounds.action(this.tree.nodes[s.cur].san);
  }

  /** Play the puzzle again (unrated: it has been played). */
  retry() {
    if (this.s) this.load(this.s.p);
  }

  // ---------------------------------------------------------------- Kairos
  /** A search of `position` for `ms`: {cp|mate (the side to move's), bestmove}. */
  search(position, ms) {
    this.stopEngine();
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, info: {} };
      this.engine.search({ position, movetime: ms, skillLevel: 8, book: false, newGame: false }).catch(reject);
      this.pendingId = this.engine.reqId;
    });
  }

  onEngine(m) {
    const p = this.pending;
    if (!p || m.id !== this.pendingId) return;
    if (m.type === 'info') {
      const t = m.line.trim().split(/\s+/);
      const i = t.indexOf('score');
      if (i >= 0 && t.indexOf('multipv') < 0) {
        p.info = t[i + 1] === 'mate' ? { mate: +t[i + 2] } : { cp: +t[i + 2] };
      }
    } else if (m.type === 'done') {
      this.pending = null;
      p.resolve({ ...p.info, bestmove: m.bestmove || null });
    } else if (m.type === 'error') {
      this.pending = null;
      p.reject(new Error(m.message));
    }
  }

  stopEngine() {
    if (this.pending) {
      this.engine.stop();
      this.pending.reject(new Error('stopped'));
      this.pending = null;
    }
  }

  // ---------------------------------------------------------------- moving around
  goto(id) {
    const s = this.s;
    if (!s || !s.line.includes(id) || id === s.cur) return;
    const forward = s.line.indexOf(id) > s.line.indexOf(s.cur);
    s.cur = id;
    this.input.reset();
    this.show();
    if (forward) sounds.action(this.tree.nodes[id].san, { check: false });
  }

  key(e) {
    const s = this.s;
    const k = e.key;
    if (k === 'Enter' || k === 'f' || k === 'F') this.input.submit();
    else if (k === 'Backspace') this.input.undo();
    else if (k === 'Escape') this.input.clear();
    else if (!s) return false;
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const i = s.line.indexOf(s.cur) + (k === 'ArrowLeft' ? -1 : 1);
      if (i >= 0 && i < s.line.length) this.goto(s.line[i]);
    } else if (k === 'ArrowUp' || k === 'Home') this.goto(s.line[0]);
    else if (k === 'ArrowDown' || k === 'End') this.goto(this.last());
    else if (k === 'h' || k === 'H') this.hint();
    else if (k === 'n' || k === 'N') { if (s.mode === 'view') this.next(); }
    else return false;
    return true;
  }

  // ---------------------------------------------------------------- drawing
  renderTop() {
    const f = puzzleFilter();
    $('#pz-theme-name').textContent = themeName(f.theme);
    const range = f.min != null || f.max != null ? `Rated ${f.min ?? 'any'}–${f.max ?? 'any'}` : '';
    $('#pz-theme-desc').textContent = [themeDesc(f.theme), range].filter(Boolean).join(' · ');
    $('#pz-difficulty').value = f.difficulty;
    $('#pz-difficulty').disabled = f.min != null || f.max != null;
    $('#pz-difficulty').title = f.min != null || f.max != null ? 'A rating range is set (on Puzzle themes): it takes the place of the difficulty.' : 'How hard, against your puzzle rating';
  }

  renderSession() {
    const rounds = puzzleSession();
    const cur = this.s && this.s.p.id;
    $('#pz-session').replaceChildren(...rounds.map((r) => el('a', {
      class: 'pz-chip ' + (r.win ? 'win' : 'loss') + (r.id === cur ? ' cur' : ''), href: `#/puzzles/${r.id}`, dataset: { id: r.id },
      title: `Puzzle ${r.id}: ${r.win ? 'solved' : 'failed'}`,
      text: r.diff == null ? (r.win ? '✓' : '✗') : `${r.diff > 0 ? '+' : ''}${r.diff}`,
    })));
    $('#pz-session-box').classList.toggle('hidden', !rounds.length);
    const rating = this.myRating;
    $('#pz-my-rating').textContent = rating != null ? String(rating) : '…';
    if (rating == null && !this.ratingAsked) {
      this.ratingAsked = true;
      rpc('puzzle_dashboard', {}).then((d) => { this.myRating = d.rating; this.renderSession(); }).catch(() => { this.ratingAsked = false; });
    }
  }

  show() {
    if (!this.active || !this.s) return;
    const s = this.s, p = s.p;
    // Feedback.
    const [title, text] = FEEDBACK[s.feedback](p);
    const fb = $('#pz-fb');
    fb.className = 'pz-fb ' + s.feedback;
    $('#pz-fb-title').textContent = title;
    $('#pz-fb-text').textContent = text;
    const turn = $('#pz-fb-turn');
    turn.src = `pieces/king-${p.side}.svg`;
    const over = s.mode === 'view';
    $('#pz-play-tools').classList.toggle('hidden', over);
    $('#pz-after').classList.toggle('hidden', !over);
    const waited = performance.now() - s.started >= (s.hinted || s.failed ? 0 : 4000);
    $('#pz-solution').classList.toggle('invisible', !(waited || s.failed || s.hinted));
    $('#pz-hint').disabled = s.busy || s.hint >= 2;
    $('#pz-hint-text').textContent = s.hint ? 'Show the move' : 'Get a hint';
    // After: how it went.
    const sent = s.sent;
    const res = $('#pz-result');
    if (over && sent && sent.diff != null) {
      res.textContent = `Your rating ${sent.rating} (${sent.diff > 0 ? '+' : ''}${sent.diff})`;
      res.className = 'pz-result ' + (sent.diff >= 0 ? 'up' : 'down');
    } else if (over && sent && !sent.pending && sent.first === false) {
      res.textContent = 'Played before: not rated again.';
      res.className = 'pz-result';
    } else if (over && sent && !sent.rated) {
      res.textContent = 'Hint used: not rated.';
      res.className = 'pz-result';
    } else {
      res.textContent = '';
      res.className = 'pz-result';
    }
    $('#pz-analyse').href = `#/analysis/puzzle/${p.id}${p.side === 'black' ? '/b' : ''}`;
    // The puzzle: its rating and themes once it is over (as lichess hides them while solving).
    const a = $('#pz-id');
    a.textContent = `#${p.id}`;
    a.href = `#/puzzles/${p.id}`;
    $('#pz-rating').textContent = over ? String(Math.round(p.rating)) : 'hidden';
    $('#pz-plays').textContent = `Played ${p.plays} time${p.plays === 1 ? '' : 's'}`;
    $('#pz-themes').replaceChildren(...(over ? p.themes.filter((t) => THEMES[t]).map((t) => el('a', {
      class: 'pz-theme-chip', href: '#/puzzles?new=1', title: themeDesc(t), text: themeName(t),
      onclick: () => setPuzzleFilter({ theme: t, min: null, max: null }),
    })) : [el('span', { class: 'muted', text: 'Themes are shown once the puzzle is over.' })]));
    this.board.setOverlay({ readonly: !this.myTurn() });
    this.renderMoves();
    this.renderSession();
    try { this.input.refresh(s.cur === this.last()); } catch (e) { toast(e.message, { error: true }); }
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
    const s = this.s;
    const box = $('#pz-moves');
    if (s.line.length < 2) {
      box.replaceChildren(el('div', { class: 'moves-empty', text: `${s.p.side === 'white' ? 'White' : 'Black'} to play.` }));
      return;
    }
    const rows = [];
    let row = null;
    const rootBlack = this.view(0).player;
    const present = this.view(0).present;
    s.line.slice(1).forEach((c, i) => {
      const n = this.tree.nodes[c];
      const k = i + rootBlack;
      const black = k % 2 === 1;
      if (!row || !black) {
        row = el('div', { class: 'mv-row' }, el('div', { class: 'mv-num', text: present + Math.floor(k / 2) + '.' }));
        rows.push(row);
        if (black) row.append(el('div', { class: 'mv empty', text: '…' }));
      }
      // The solver's actions: right (green) or, while being judged, plain.
      const mine = (k % 2 === 1) === (s.solver === 'b');
      row.append(el('div', { class: 'mv' + (c === s.cur ? ' cur' : '') + (mine ? ' pz-mine' : ''), dataset: { id: c }, title: n.lan }, moveText(n) || n.lan));
      if (black) row = null;
    });
    box.replaceChildren(...rows);
    const cur = box.querySelector('.cur');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
}

/** The dashboard (#/puzzles/themes): rating, filters, themes with what is left, history. */
export class PuzzleThemes {
  constructor(app) {
    this.app = app;
    this.data = null;
  }

  init() {
    const seg = $('#pzh-difficulty');
    seg.replaceChildren(...DIFFICULTIES.map(([id, name]) => el('button', { type: 'button', dataset: { id }, text: name })));
    seg.onclick = (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) { setPuzzleFilter({ difficulty: b.dataset.id }); this.renderFilters(); }
    };
    const read = (input) => (input.value.trim() === '' ? null : Math.max(0, Math.round(+input.value)));
    const applyRange = () => {
      let min = read($('#pzh-min')), max = read($('#pzh-max'));
      if (min != null && max != null && min > max) [min, max] = [max, min];
      setPuzzleFilter({ min, max });
      this.load();
    };
    $('#pzh-min').onchange = applyRange;
    $('#pzh-max').onchange = applyRange;
    $('#pzh-range-clear').onclick = () => { setPuzzleFilter({ min: null, max: null }); this.load(); };
    $('#pzh-presets').onclick = (e) => {
      const b = e.target.closest('button[data-min]');
      if (!b) return;
      setPuzzleFilter({ min: b.dataset.min === '' ? null : +b.dataset.min, max: b.dataset.max === '' ? null : +b.dataset.max });
      this.load();
    };
    $('#pzh-replay').onchange = (e) => { setPuzzleFilter({ replay: e.target.checked }); this.render(); };
    $('#pzh-groups').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-theme]');
      if (a) setPuzzleFilter({ theme: a.dataset.theme || null });
    });
  }

  activate() {
    $('#puzzles').scrollTop = 0;
    this.renderFilters();
    this.load();
  }

  async load() {
    this.renderFilters();
    const f = puzzleFilter();
    try {
      this.data = await rpc('puzzle_dashboard', { p_min: f.min, p_max: f.max });
      $('#pzh-error').classList.add('hidden');
    } catch (e) {
      $('#pzh-error').textContent = 'Puzzles are not available right now: ' + e.message;
      $('#pzh-error').classList.remove('hidden');
    }
    this.render();
  }

  renderFilters() {
    const f = puzzleFilter();
    const ranged = f.min != null || f.max != null;
    for (const b of $('#pzh-difficulty').children) b.classList.toggle('on', !ranged && b.dataset.id === f.difficulty);
    $('#pzh-difficulty').classList.toggle('dim', ranged);
    $('#pzh-min').value = f.min ?? '';
    $('#pzh-max').value = f.max ?? '';
    $('#pzh-range-clear').classList.toggle('hidden', !ranged);
    for (const b of $('#pzh-presets').children) {
      b.classList.toggle('on', String(f.min ?? '') === b.dataset.min && String(f.max ?? '') === b.dataset.max);
    }
    $('#pzh-replay').checked = !!f.replay;
    $('#pzh-filter-note').textContent = ranged
      ? `Puzzles rated ${f.min ?? 'any'}–${f.max ?? 'any'} (the range takes the place of the difficulty).`
      : `Puzzles near your rating${f.difficulty === 'normal' ? '' : `, ${DIFFICULTIES.find((d) => d[0] === f.difficulty)[1].toLowerCase()}`}.`;
  }

  render() {
    const d = this.data;
    const f = puzzleFilter();
    if (d) {
      // Provisional while the deviation is wide (lichess's 110).
      $('#pzh-rating').textContent = d.rd <= 110 ? String(d.rating) : `${d.rating}?`;
      $('#pzh-rating').title = d.rd <= 110 ? `Glicko-2, deviation ${d.rd}` : `Provisional (deviation ${d.rd}): play more rated puzzles`;
      $('#pzh-solved').textContent = String(d.solved);
      $('#pzh-played').textContent = String(d.played);
      $('#pzh-left').textContent = String(d.left);
      $('#pzh-range-hint').textContent = d.range ? `Puzzles are rated ${d.range.min}–${d.range.max}.` : '';
    }
    const by = new Map((d ? d.themes : []).map((t) => [t.theme, t]));
    const ranged = f.min != null || f.max != null;
    const tile = (theme) => {
      const t = theme ? by.get(theme) : null;
      const total = theme ? (t ? (ranged ? t.in_range : t.total) : 0) : d ? (ranged ? d.left + 0 : d.total) : 0;
      const left = theme ? (t ? t.left : 0) : d ? d.left : 0;
      const played = theme ? (t ? t.played : 0) : d ? d.played : 0;
      const all = theme ? (t ? t.total : 0) : d ? d.total : 0;
      const count = f.replay ? `${total} puzzle${total === 1 ? '' : 's'}` : `${left} new`;
      return el('a', {
        class: 'pzh-theme' + ((f.theme || null) === (theme || null) ? ' on' : '') + (!f.replay && left === 0 && d ? ' done' : ''),
        href: '#/puzzles?new=1', dataset: { theme: theme || '' },
      },
      el('span', { class: 'pzh-theme-name', text: themeName(theme) }),
      el('span', { class: 'pzh-theme-desc', text: themeDesc(theme) }),
      el('span', { class: 'pzh-theme-foot' },
        el('span', { class: 'pzh-count', text: d ? count : '' }),
        el('span', { class: 'pzh-bar', title: d ? `${played} of ${all} played` : '' }, el('i', { style: `width:${all ? (100 * played) / all : 0}%` }))));
    };
    const groups = [el('section', { class: 'pzh-group' }, el('h2', { text: 'Recommended' }), el('div', { class: 'pzh-grid' }, tile(null)))];
    for (const [id, name] of GROUPS) {
      const themes = Object.keys(THEMES).filter((t) => THEMES[t][2] === id && (!d || by.has(t)));
      if (themes.length) groups.push(el('section', { class: 'pzh-group' }, el('h2', { text: name }), el('div', { class: 'pzh-grid' }, ...themes.map(tile))));
    }
    $('#pzh-groups').replaceChildren(...groups);
    const recent = d ? d.recent : [];
    $('#pzh-history-box').classList.toggle('hidden', !recent.length);
    $('#pzh-history').replaceChildren(...recent.map((r) => el('a', {
      class: 'pz-chip ' + (r.win ? 'win' : 'loss'), href: `#/puzzles/${r.id}`,
      title: `Puzzle ${r.id} (rated ${r.rating}): ${r.win ? 'solved' : 'failed'}${r.rated ? '' : ', unrated'} · ${new Date(r.at).toLocaleString()}`,
      text: r.diff == null ? (r.win ? '✓' : '✗') : `${r.diff > 0 ? '+' : ''}${r.diff}`,
    })));
  }
}

/** For the analysis board: a puzzle's start and line as a record it loads. */
export async function puzzleRecord(id) {
  const c = sb();
  if (!c) throw new Error('Puzzles are not available right now.');
  const { data, error } = await c.from('puzzles').select('position, solution, side').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('That puzzle does not exist.');
  return { text: JSON.stringify({ position: data.position, moves: data.solution.join(' submit ') }), black: data.side === 2 };
}
