// Which page the address names, and showing its sections. A classic script loaded in the head:
// the document runs `kairosShow` as soon as the page's markup is parsed, so a reload shows the
// right page from the first paint instead of the analysis board until the app has loaded
// (main.js routes with the same two functions from then on).

/** The page of `hash` and its parameters (see main.js's `route`). */
function kairosPage(hash) {
  const [path, qs] = (hash || '#/').slice(2).split('?');
  const params = new URLSearchParams(qs || '');
  const [head, id, color, side] = path.split('/');
  // #/game/<id>: a challenge or an online game.
  if (head === 'game' && id) params.set('id', id);
  // The old Play page's links (#/play[?position=...]): the home page's options against Kairos.
  if (head === 'play') params.set('play', 'computer');
  // #/analysis/<id>[/w|/b]: a finished online game on the analysis board, from that side.
  // #/analysis/puzzle/<id>[/b]: a puzzle and its solution on the analysis board.
  if (head === 'analysis' && id === 'puzzle' && color) {
    params.set('puzzle', color);
    if (side === 'b') params.set('color', 'b');
  } else if (head === 'analysis' && id) {
    params.set('online', id);
    if (color === 'w' || color === 'b') params.set('color', color);
  }
  // #/puzzles/themes (and plain #/puzzles): the themes; #/puzzles?new=1: the next puzzle;
  // #/puzzles/<id>: that one.
  if (head === 'puzzles' && id && id !== 'themes') params.set('id', id);
  const pages = ['home', 'puzzles', 'analysis', 'editor', 'games', 'rules', 'openings', 'practice'];
  let name = pages.includes(head) ? head : head === 'game' && id ? 'game' : 'home';
  if (head === 'puzzles' && (id === 'themes' || (!id && !params.get('new')))) name = 'puzzlethemes';
  return { name, params };
}

/** Pages on the board workspace (the others are full-page sections). */
const KAIROS_BOARD_PAGES = ['game', 'puzzles', 'analysis', 'play', 'editor', 'practice'];

/** Show page `name`'s sections and mark its tab in the header. */
function kairosShow(name) {
  const $ = (s) => document.querySelector(s);
  const toggle = (sel, hidden) => { const e = $(sel); if (e) e.classList.toggle('hidden', hidden); };
  // An online game is part of Play.
  const navRoute = name === 'game' ? 'home' : name === 'puzzlethemes' ? 'puzzles' : name;
  document.querySelectorAll('.site-nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === navRoute));
  document.querySelectorAll('.nav-group').forEach((g) => g.classList.toggle('on', !!g.querySelector(`a[data-route="${navRoute}"]`)));
  toggle('#workspace', !KAIROS_BOARD_PAGES.includes(name));
  toggle('#home', name !== 'home');
  toggle('#puzzles', name !== 'puzzlethemes');
  toggle('#side-puzzle', name !== 'puzzles');
  if (name !== 'puzzles') toggle('#pz-empty', true);
  if (name !== 'game') toggle('#challenge', true);
  toggle('#side-game', name !== 'game');
  toggle('#openings', name !== 'openings');
  toggle('#rules', name !== 'rules');
  toggle('#browser', name !== 'games');
  toggle('#side-analysis', name !== 'analysis');
  toggle('#side-play', name !== 'play');
  toggle('#side-editor', name !== 'editor');
  toggle('#side-practice', name !== 'practice');
  if (name !== 'practice') toggle('#practice-select', true);
  const ws = $('#workspace');
  if (ws) ws.classList.toggle('editing', name === 'editor');
}
