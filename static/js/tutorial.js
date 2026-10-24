// The tutorial (Learn → Tutorial): short lessons that teach 5D chess by doing, after
// lichess.org/learn. Each step shows one short message and asks for one thing: a move on the
// board, a click on a board, an answer, or just reading. Marks on the board (gold rings, lit
// squares, arrows, red threats, the void) point at what the step is about. A wrong move is
// explained and taken back; repeated misses bring a hint (the piece), then the answer (the
// arrow). Lessons give 1-3 stars (fewer for misses and hints), kept in this browser. The
// lessons themselves are in lessons.js; nothing here is sent anywhere.
import { Rules } from './kairos.js';
import { sounds } from './sound.js';
import { LESSONS, parseMoves, marksOf, onTarget, moveLan } from './lessons.js';
import { $, el, toast, store } from './util.js';

const STORAGE_KEY = 'tutorial';
const STAR = 'M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5L2.5 9.3l6.6-.8z';
const PRAISE = ['Nice!', 'Well done!', 'Exactly!', 'Great!', 'Correct!', 'You got it!'];

/** Best stars per lesson in this browser: {id: 1..3}. */
export function tutorialStars() {
  const s = store(STORAGE_KEY);
  return s && typeof s === 'object' ? s : {};
}

function saveStars(id, stars) {
  const all = tutorialStars();
  if ((all[id] || 0) < stars) store(STORAGE_KEY, { ...all, [id]: stars });
}

/** `**bold**` in lesson text as <b> (the text is the lessons' own, never user input). */
function rich(text) {
  const out = [];
  String(text).split(/\*\*(.+?)\*\*/).forEach((part, i) => { if (part) out.push(i % 2 ? el('b', { text: part }) : part); });
  return out;
}

function stars(n, cls = '') {
  const svg = (on) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('class', 'tut-star' + (on ? ' on' : ''));
    s.innerHTML = `<path d="${STAR}"/>`;
    return s;
  };
  return el('span', { class: 'tut-stars ' + cls, title: n ? `${n} of 3 stars` : 'Not completed yet' }, svg(n >= 1), svg(n >= 2), svg(n >= 3));
}

export class Tutorial {
  constructor(app) {
    this.app = app;
    this.board = app.board;
    this.input = app.input;
    this.lesson = null; // index into LESSONS
    this.step = 0;
    this.node = 0;
    this.phase = 'idle'; // 'doing' | 'done' | 'busy' | 'complete'
    this.source = {
      mode: 'tutorial',
      rules: null,
      node: () => this.node,
      canMove: () => this.canMove(),
      blocked: () => this.blocked(),
      submit: (moves) => this.submit(moves),
      onView: (v, draft) => this.onView(v, draft),
      onClick: (sq) => this.onClick(sq),
      onMove: (mv, draft) => this.onMove(mv, draft),
    };
  }

  async init() {
    this.rules = await Rules.create();
    this.source.rules = this.rules;
    this.rules.call({ cmd: 'new', position: 'Standard' });
    $('#tut-next').onclick = () => this.next();
    $('#tut-hint').onclick = () => this.hint();
    $('#tut-retry').onclick = () => this.enter(this.step, { retry: true });
    $('#tut-lessons').addEventListener('click', (e) => {
      const b = e.target.closest('[data-lesson]');
      if (b) location.hash = `#/tutorial/${b.dataset.lesson}`;
    });
    this.renderList();
  }

  get cur() { return LESSONS[this.lesson]; }
  get st() { return this.cur.steps[this.step]; }

  // ---------------------------------------------------------------- page
  activate(params) {
    this.active = true;
    this.input.attach(this.source);
    this.board.setFlipped(false);
    const id = params && params.get('lesson');
    const i = LESSONS.findIndex((l) => l.id === id);
    if (i < 0) {
      this.openList();
      this.board.setView(this.rules.call({ cmd: 'view', node: 0, draft: [] }).view);
      this.board.setOverlay({ lesson: null, hint: [] });
      return;
    }
    $('#tutorial-select').classList.add('hidden');
    if (i !== this.lesson || this.phase === 'idle' || this.phase === 'complete') this.start(i);
    else this.enter(this.step, { retry: true });
  }

  deactivate() {
    this.active = false;
    clearTimeout(this.timer);
    $('#draft-submit').classList.remove('tut-pulse');
    this.board.setOverlay({ lesson: null, hint: [], readonly: false });
  }

  openList() {
    this.renderList();
    $('#tutorial-select').classList.remove('hidden');
  }

  renderList() {
    const got = tutorialStars();
    const done = LESSONS.filter((l) => got[l.id]).length;
    const next = LESSONS.find((l) => !got[l.id]);
    $('#tut-progress-count').textContent = `${done} / ${LESSONS.length}`;
    $('#tut-progress-fill').style.width = `${(100 * done) / LESSONS.length}%`;
    $('#tut-lessons').replaceChildren(...LESSONS.map((l, i) => el('button', {
      type: 'button', class: 'tut-lesson' + (got[l.id] ? ' done' : '') + (l === next ? ' next' : ''), dataset: { lesson: l.id },
    },
    el('span', { class: 'tut-lesson-num', text: String(i + 1) }),
    el('span', { class: 'tut-lesson-body' }, el('strong', { text: l.title }), el('span', { class: 'muted', text: l.blurb })),
    stars(got[l.id] || 0))));
  }

  // ---------------------------------------------------------------- lessons and steps
  start(i) {
    this.lesson = i;
    this.misses = 0;
    this.board.fitted = false;
    $('#tut-title').textContent = this.cur.title;
    $('#tut-count').textContent = `Lesson ${i + 1} of ${LESSONS.length}`;
    $('#tut-done').classList.add('hidden');
    $('#tut-coach').classList.remove('hidden');
    this.enter(0);
  }

  /**
   * Open step `k`: its own position (`at`), or where the step before left the game (or, when
   * the step is retried, where it began); then the opponent's opening action (`then`).
   */
  enter(k, { retry = false } = {}) {
    clearTimeout(this.timer);
    this.step = k;
    this.stepMisses = 0;
    this.found = new Set();
    this.hinted = 0;
    const st = this.st;
    if (st.at) {
      this.rules.call({ cmd: 'new', position: st.at[0] });
      this.node = st.at[1] ? this.rules.call({ cmd: 'play_line', node: 0, line: st.at[1] }).node : 0;
      if (!retry) this.board.fitted = false;
    } else if (retry && this.entryNode != null) {
      this.node = this.entryNode;
    }
    this.entryNode = this.node;
    this.stepNode = this.node;
    this.input.reset();
    $('#draft-submit').classList.remove('tut-pulse');
    $('#tut-options').dataset.step = '';
    this.phase = st.then ? 'busy' : 'doing';
    this.render();
    this.show();
    if (st.then) {
      this.timer = setTimeout(() => {
        this.playOpponent(st.then);
        this.stepNode = this.node;
        this.phase = 'doing';
        this.render();
        this.show();
      }, 700);
    }
  }

  next() {
    if (this.phase === 'complete') return this.nextLesson();
    if (this.phase !== 'done' && !(this.st.type === 'read' && this.phase === 'doing')) return;
    if (this.step + 1 < this.cur.steps.length) this.enter(this.step + 1);
    else this.complete();
  }

  complete() {
    this.phase = 'complete';
    const n = this.misses === 0 ? 3 : this.misses <= 2 ? 2 : 1;
    saveStars(this.cur.id, n);
    sounds.play('win');
    $('#tut-coach').classList.add('hidden');
    const last = this.lesson === LESSONS.length - 1;
    const box = $('#tut-done');
    box.replaceChildren(
      el('div', { class: 'tut-done-head' }, el('strong', { text: last ? 'You know the rules of 5D chess!' : 'Lesson complete!' }), stars(n, 'big')),
      el('ul', { class: 'tut-recap' }, ...this.cur.recap.map((r) => el('li', { text: r }))),
      last ? el('div', { class: 'tut-grad' },
        el('p', { class: 'muted', text: 'Where to next:' }),
        el('a', { class: 'btn block', href: '#/practice', text: 'Checkmate practice' }),
        el('a', { class: 'btn block', href: '#/puzzles/themes', text: 'Puzzles' }),
        el('a', { class: 'btn primary block', href: '#/play', text: 'Play the computer' }))
        : el('button', { type: 'button', class: 'btn primary block', onclick: () => this.nextLesson(), text: `Next: ${LESSONS[this.lesson + 1].title}` }),
      el('a', { class: 'btn block', href: '#/tutorial', text: 'All lessons' }),
    );
    box.classList.remove('hidden');
    this.board.setOverlay({ lesson: null, hint: [] });
    this.renderDots();
  }

  nextLesson() {
    if (this.lesson + 1 < LESSONS.length) location.hash = `#/tutorial/${LESSONS[this.lesson + 1].id}`;
    else location.hash = '#/tutorial';
  }

  // ---------------------------------------------------------------- the board
  view() { return this.rules.call({ cmd: 'view', node: this.node, draft: [] }).view; }

  canMove() {
    return this.active && this.phase === 'doing' && this.st && this.st.type === 'play';
  }

  blocked() {
    if (this.phase === 'busy') return;
    if (this.phase === 'done') toast('Press Continue for the next step');
    else if (this.st && this.st.type === 'click') return;
    else if (this.st && this.st.type !== 'play') toast(this.st.type === 'choose' ? 'Pick an answer on the right' : 'Press Continue');
  }

  /** The step's marks, the hint ring (after misses) and the move input, on the board. */
  show() {
    if (!this.active) return;
    const st = this.st;
    let v;
    try { v = this.view(); } catch (e) { toast(e.message, { error: true }); return; }
    const marks = this.phase === 'complete' ? null : marksOf(st.mark, v.player);
    let lesson = marks;
    // Hints: the piece(s) to move after a second miss; the arrows after a third.
    const sol = st.type === 'play' && st.solution ? parseMoves(st.solution) : [];
    const hint = this.hinted >= 1 ? sol.map((m) => ({ l: m.from[0], t: m.from[1], c: v.player, x: m.from[2], y: m.from[3] })) : [];
    if (this.hinted >= 2 && sol.length) {
      lesson = { ...(marks || {}), arrows: [...((marks && marks.arrows) || []), ...sol.map((m) => ({ from: m.from, to: m.to, c: v.player }))] };
    }
    // Click steps: the boards already found, ringed.
    if (st.type === 'click' && this.found.size) {
      lesson = { ...(lesson || {}), boards: [...((lesson && lesson.boards) || []), ...[...this.found].map((t) => marksOf({ boards: [t] }, v.player).boards[0])] };
    }
    // A move made: the marks and hints that led to it give way to its result.
    const played = st.type === 'play' && this.phase !== 'doing';
    this.board.setOverlay({ lesson: played ? null : lesson, hint: played ? [] : hint, readonly: !this.canMove(), pv: [] });
    try { this.input.refresh(true); } catch (e) { toast(e.message, { error: true }); }
    // Lessons are small: the whole multiverse stays in view (except while an action is built).
    if (!this.input.draft.length) this.board.fit(true);
    $('#eval-bar').classList.add('hidden');
  }

  onView(v, draft) {
    const st = this.st;
    if (!st || st.type !== 'play' || this.phase !== 'doing' || !draft.length) return;
    // A goal step's action, complete: Submit is asked for.
    if (st.goal) this.askSubmit(v.canSubmit);
  }

  /** A move of the action being built: an exact step takes only its solution's moves. */
  onMove(mv, draft) {
    const st = this.st;
    if (!st || st.type !== 'play' || st.goal) return true;
    const want = parseMoves(st.solution).map(moveLan);
    const lan = moveLan(mv);
    const played = draft.map(moveLan);
    if (!want.includes(lan) || played.includes(lan)) {
      this.miss((st.why && st.why[lan]) || st.wrong || 'Not that move. Look at the marks on the board.');
      return false;
    }
    if (played.length + 1 === want.length) this.askSubmit(true);
    return true;
  }

  /**
   * An action ready (`ready`) or not: the tutorial never submits for the learner, as in a game
   * nothing is played until Submit, so it asks for it and makes the button pulse.
   */
  askSubmit(ready) {
    $('#draft-submit').classList.toggle('tut-pulse', ready);
    if (!ready) return;
    const first = this.lesson === 0;
    this.say(first ? 'Good. Now press **Submit** (or F) to end your turn.' : 'Now press **Submit** (or F).', 'nudge');
  }

  async submit(moves) {
    const st = this.st;
    if (!st || st.type !== 'play' || this.phase !== 'doing') throw new Error('Not now');
    $('#draft-submit').classList.remove('tut-pulse');
    const before = this.view();
    const r = this.rules.call({ cmd: 'play', node: this.node, moves });
    const tree = r.tree;
    this.node = r.node;
    sounds.action(tree.nodes[r.node].san, { move: true });
    if (st.goal) {
      const verdict = st.goal({ moves, before, after: this.view() });
      if (verdict !== true) {
        // Show the action, then take it back.
        this.phase = 'busy';
        this.show();
        this.miss(verdict || st.wrong || 'Not quite.');
        this.timer = setTimeout(() => {
          this.rules.call({ cmd: 'delete', node: this.node });
          this.node = this.stepNode;
          this.phase = 'doing';
          this.render(true);
          this.show();
        }, 1400);
        return;
      }
    }
    if (st.reply) {
      this.phase = 'busy';
      this.render(true);
      this.show();
      this.timer = setTimeout(() => {
        this.playOpponent(st.reply);
        this.success();
      }, 650);
      return;
    }
    this.success();
  }

  playOpponent(lan) {
    const r = this.rules.call({ cmd: 'play', node: this.node, moves: parseMoves(lan) });
    this.node = r.node;
    if (this.active) sounds.action(r.tree.nodes[r.node].san);
    this.show();
  }

  onClick(sq) {
    const st = this.st;
    if (!st || this.phase !== 'doing' || st.type !== 'click') return false;
    if (!sq) return true;
    const hit = st.targets.find((t) => onTarget(sq, t));
    if (hit) {
      this.found.add(hit);
      if (!st.all || this.found.size === st.targets.length) this.success();
      else { this.say(`Good: ${this.found.size} of ${st.targets.length}.`, 'good'); this.show(); }
      return true;
    }
    const board = `(${sq.l}T${sq.t}${sq.c ? 'b' : 'w'})`;
    if (st.all && [...this.found].some((t) => onTarget(sq, t))) return true;
    this.miss((st.why && st.why[board]) || st.wrong || 'Not that one.');
    return true;
  }

  choose(i) {
    const st = this.st;
    if (this.phase !== 'doing') return;
    const buttons = [...document.querySelectorAll('#tut-options button')];
    if (st.predict) {
      buttons.forEach((b, j) => {
        if (j === st.answer) b.classList.add('right');
        else if (j === i) b.classList.add('picked');
        b.disabled = true;
      });
      this.success(i === st.answer ? 'Good guess!' : 'Not quite, and that’s fine.');
      return;
    }
    if (i === st.answer) {
      buttons[i].classList.add('right');
      buttons.forEach((b) => { b.disabled = true; });
      this.success();
    } else {
      buttons[i].classList.add('wrong');
      buttons[i].disabled = true;
      this.miss('Not quite. Try again.');
    }
  }

  /** A miss: the reason, and on further misses the hint ladder (piece, then arrows). */
  miss(text) {
    this.misses++;
    this.stepMisses++;
    if (this.stepMisses >= 2 && this.st.type === 'play') this.hinted = Math.min(2, this.stepMisses - 1);
    this.say(text, 'bad');
    this.renderHint();
    if (this.phase === 'doing') this.show();
  }

  /** The hint button: the piece to move, then the move itself (each counts as a miss). */
  hint() {
    if (this.phase !== 'doing' || this.st.type !== 'play' || !this.st.solution) return;
    this.hinted = Math.min(2, this.hinted + 1);
    this.misses++;
    this.say(this.hinted === 1 ? 'The piece to move is ringed in green.' : 'Follow the gold arrow.', 'hint');
    this.renderHint();
    this.show();
  }

  success(lead) {
    this.phase = 'done';
    const st = this.st;
    const praise = lead || (st.type === 'read' ? '' : PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    this.render();
    this.say(st.ok || '', 'good', praise);
    this.show();
  }

  // ---------------------------------------------------------------- the panel
  render(keepFeedback = false) {
    const st = this.st;
    $('#tut-say').replaceChildren(...rich(st.say));
    const opts = $('#tut-options');
    if (st.type === 'choose') {
      if (this.phase !== 'done' && opts.dataset.step !== `${this.lesson}:${this.step}`) {
        opts.replaceChildren(...st.options.map((o, i) => el('button', { type: 'button', class: 'tut-option', onclick: () => this.choose(i) }, ...rich(o))));
        opts.dataset.step = `${this.lesson}:${this.step}`;
      }
      opts.classList.remove('hidden');
    } else {
      opts.replaceChildren();
      opts.dataset.step = '';
      opts.classList.add('hidden');
    }
    if (!keepFeedback && this.phase === 'doing') this.say('', '');
    const next = $('#tut-next');
    const ready = this.phase === 'done' || (st.type === 'read' && this.phase === 'doing');
    next.classList.toggle('hidden', !ready);
    next.textContent = this.step + 1 < this.cur.steps.length ? 'Continue' : 'Finish lesson';
    $('#tut-task').textContent = { play: 'Your move', click: 'Click on the board', choose: 'Pick an answer', read: '' }[st.type] || '';
    $('#tut-task').classList.toggle('hidden', ready || st.type === 'read');
    this.renderHint();
    this.renderDots();
    if (ready) setTimeout(() => next.focus({ preventScroll: true }), 0);
  }

  renderHint() {
    const st = this.st;
    const doing = this.phase === 'doing' && st.type === 'play' && this.stepMisses > 0;
    $('#tut-hint').classList.toggle('hidden', !(doing && !!st.solution && this.hinted < 2));
    $('#tut-retry').classList.toggle('hidden', !doing);
  }

  renderDots() {
    const n = this.cur.steps.length;
    const dots = [];
    for (let i = 0; i < n; i++) {
      const cls = i < this.step || (i === this.step && (this.phase === 'done' || this.phase === 'complete')) ? 'done' : i === this.step ? 'cur' : '';
      dots.push(el('span', { class: 'tut-dot ' + cls }));
    }
    $('#tut-dots').replaceChildren(...dots);
  }

  /** The feedback line: `kind` good, bad, hint or nudge (empty clears it). */
  say(text, kind, lead = '') {
    const fb = $('#tut-feedback');
    fb.className = 'tut-feedback ' + (kind || '');
    fb.classList.toggle('hidden', !text && !lead);
    fb.replaceChildren(...(lead ? [el('strong', { text: lead + ' ' })] : []), ...rich(text));
  }

  key(e) {
    const k = e.key;
    if ((k === 'Enter' || k === ' ') && (this.phase === 'done' || this.phase === 'complete' || (this.st && this.st.type === 'read'))) {
      this.next();
      return true;
    }
    if (!this.st || this.st.type !== 'play') return false;
    if (k === 'Enter' || k === 'f' || k === 'F') this.input.submit();
    else if (k === 'Backspace') this.input.undo();
    else if (k === 'Escape') this.input.clear();
    else return false;
    return true;
  }
}
