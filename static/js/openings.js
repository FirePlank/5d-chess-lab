import { Rules } from './kairos.js';
import { OpeningTree, openingUrl, bookVariants } from './opening-tree.js';
import { VariantPicker } from './variant-picker.js';
import { $, el } from './util.js';
import { parseFen } from './board.js';
import { positionFromView } from './position.js';

const pieces = { k: 'king', q: 'queen', b: 'bishop', n: 'knight', r: 'rook', p: 'pawn',
  u: 'unicorn', d: 'dragon', w: 'brawn', s: 'princess', y: 'royalqueen', c: 'commonking' };

/** Latest board on every timeline; time-travel continuations keep their extra boards. */
function preview(view) {
  const [w, h] = view.size;
  const latest = new Map();
  for (const board of view.boards) {
    const old = latest.get(board[0]);
    if (!old || board[1] * 2 + board[2] > old[1] * 2 + old[2]) latest.set(board[0], board);
  }
  const root = el('div', { class: 'opening-boards', 'aria-hidden': 'true' });
  for (const [l, t, c, fen] of [...latest.values()].sort((a, b) => a[0] - b[0])) {
    const board = el('div', { class: 'opening-mini', style: `--files:${w};aspect-ratio:${w}/${h}` });
    const squares = parseFen(fen, w, h);
    for (let y = h - 1; y >= 0; y--) for (let x = 0; x < w; x++) {
      const highlighted = view.last.some(m => [m.from, m.to].some(s => s[0] === l && s[2] === x && s[3] === y));
      const square = el('span', { class: `mini-square ${(x + y) % 2 ? 'light' : 'dark'}${highlighted ? ' last' : ''}` });
      const p = squares[y * w + x]?.p;
      if (p && pieces[p.toLowerCase()]) square.append(el('img', { src: `pieces/${pieces[p.toLowerCase()]}-${p === p.toUpperCase() ? 'white' : 'black'}.svg`, alt: '', loading: 'lazy', draggable: 'false' }));
      board.append(square);
    }
    root.append(el('div', { class: 'opening-mini-wrap' }, board,
      el('span', { class: 'mini-coordinate', text: `L${view.timelines.find(tl => tl.l === l)?.label ?? l} · T${t}${c ? 'b' : 'w'}` })));
  }
  return root;
}

export class Openings {
  constructor(app) { this.app = app; }
  async activate(params) {
    const request = this.request = (this.request || 0) + 1;
    $('#opening-error').textContent = '';
    try {
      if (!this.ready) this.ready = Rules.create().then(rules => { this.tree = new OpeningTree(rules); });
      await this.ready;
      if (request !== this.request || this.app.route !== 'openings') return;
      const variants = this.variants ||= bookVariants(this.tree.rules, this.app.pages.analysis.variants);
      this.variant = params.get('variant') || 'Standard - Turn Zero';
      if (!variants.some(v => v.name === this.variant)) throw new Error('No opening book for this variant.');
      this.moves = JSON.parse(params.get('moves') || '[]');
      if (!Array.isArray(this.moves) || !this.moves.every(m => typeof m === 'string')) throw new Error('Invalid opening line.');
      if (!this.picker) this.picker = new VariantPicker($('#opening-variant'), { variants, flat: true,
        onChange: variant => { location.hash = openingUrl(variant); } });
      this.picker.setValue(this.variant);
      this.tree.load(this.variant, this.moves);
      this.render();
    } catch (e) {
      $('#opening-content').replaceChildren();
      $('#opening-error').replaceChildren(el('p', { text: e.message }), el('a', { href: '#/openings', text: 'Back to openings' }));
    }
  }
  deactivate() { this.request = (this.request || 0) + 1; this.picker?.close(); }
  render() {
    const tree = this.tree;
    const crumbs = el('nav', { class: 'opening-path', 'aria-label': 'Opening moves' },
      el('a', { href: openingUrl(this.variant), text: 'Starting position', 'aria-current': this.moves.length ? null : 'page' }));
    tree.path.slice(1).forEach((m, i) => crumbs.append(el('span', { class: 'path-separator', text: '›' }),
      el('a', { href: openingUrl(this.variant, this.moves.slice(0, i + 1)), text: m.pgn,
        'aria-current': i === this.moves.length - 1 ? 'page' : null })));
    const heading = el('div', { class: 'opening-heading' }, el('h1', { text: tree.opening?.name || (this.moves.length ? tree.path.at(-1).pgn : 'Chess openings') }));
    const uci = 'position ' + tree.start + (this.moves.length ? ' moves ' + this.moves.join(' submit ') + ' submit' : '');
    const actions = el('div', { class: 'opening-actions' },
      el('a', { class: 'btn', href: '#/analysis?uci=' + encodeURIComponent(uci), text: 'Analyse position' }),
      el('a', { class: 'btn', href: '#/play?position=' + encodeURIComponent(positionFromView(tree.view)), text: 'Play from here' }));
    const intro = this.moves.length ? el('div', { class: 'opening-intro' }, preview(tree.view), actions) : actions;
    const grid = el('div', { class: 'opening-nexts' });
    for (const move of tree.children) {
      const named = move.opening?.node === move.node ? move.opening.name : null;
      grid.append(el('a', { class: 'opening-next', href: openingUrl(this.variant, [...this.moves, move.lan]),
        'aria-label': `${move.pgn}${named ? ', ' + named : ''}, ${move.count} continuations` },
      el('div', { class: 'opening-next-title' }, el('strong', { text: named || move.pgn }),
        named ? el('span', { class: 'opening-next-move', text: move.pgn }) : null),
      preview(move.view), el('div', { class: 'opening-next-meta' },
        el('span', { text: move.count ? `${move.count} continuation${move.count === 1 ? '' : 's'}` : 'End of book line' }),
        el('span', { text: 'Explore →' }))));
    }
    const section = el('h2', { class: 'opening-next-heading', text: this.moves.length ? 'Continuations' : 'First moves' });
    $('#opening-content').replaceChildren(crumbs, heading, intro, section,
      tree.children.length ? grid : el('p', { class: 'opening-empty', text: 'No further moves in the opening book. Continue exploring this position on the analysis board.' }));
    $('#openings').scrollTop = 0;
  }
}
