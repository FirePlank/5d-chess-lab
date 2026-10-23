// 5D Chess Lab's shell: routing between Analysis, Play, the board editor and Games, theme,
// shared board and engine.
import { MultiverseView } from './board.js';
import { MoveInput } from './input.js';
import { sounds } from './sound.js';
import { bindCameraKeys } from './camera-keys.js';
import { bindSiteNav } from './site-nav.js';
import { Engine, defaultEngineSettings } from './kairos.js';
import { Analysis } from './analysis.js';
import { Play } from './play.js';
import { Openings } from './openings.js';
import { Games } from './games.js';
import { Editor } from './editor.js';
import { Practice } from './practice.js';
import { Home } from './home.js';
import { OnlineGame } from './online.js';
import { Puzzles, PuzzleThemes } from './puzzles.js';
import { setRules } from './static-api.js';
import { moveText, notationSettings, setNotation } from './notation.js';
import { prefs, setPref } from './prefs.js';
import { $, $$, toast, store, bindDialogDismiss } from './util.js';

/** Saved analysis-engine settings over the defaults. */
export function engineSettings() {
  const s = { ...defaultEngineSettings(), ...(store('engineSettings') || {}) };
  // Never more threads than logical cores (a setting saved on another machine, say).
  s.threads = Math.max(1, Math.min(s.threads | 0, navigator.hardwareConcurrency || 2));
  return s;
}

const app = {
  route: null,
  board: null,
  input: null,
  engine: new Engine(engineSettings()),
  server: null,
};

async function serverInfo() {
  try {
    const r = await fetch('api/info');
    if (r.ok) return await r.json();
  } catch (e) { /* static hosting: no server */ }
  return null;
}

const PAGES = ['home', 'game', 'puzzles', 'puzzlethemes', 'analysis', 'play', 'editor', 'games', 'rules', 'openings', 'practice'];
/** Pages on the board workspace (the others are full-page sections). */
const BOARD_PAGES = ['game', 'puzzles', 'analysis', 'play', 'editor', 'practice'];

function route() {
  const hash = location.hash || '#/';
  const [path, qs] = hash.slice(2).split('?');
  const params = new URLSearchParams(qs || '');
  // #/game/<id>: a challenge or an online game.
  const [head, id, color] = path.split('/');
  if (head === 'game' && id) params.set('id', id);
  // The old Play page's links (#/play[?position=...]): the home page's options against Kairos.
  if (head === 'play') params.set('play', 'computer');
  // #/analysis/<id>[/w|/b]: a finished online game on the analysis board, from that side.
  // #/analysis/puzzle/<id>[/b]: a puzzle and its solution on the analysis board.
  const side = path.split('/')[3];
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
  if (head === 'puzzles' && !id && !params.get('new')) history.replaceState(null, '', '#/puzzles/themes');
  let name = PAGES.includes(head) && head !== 'game' && head !== 'play' && head !== 'puzzlethemes' ? head : head === 'game' && id ? 'game' : 'home';
  if (head === 'puzzles' && (id === 'themes' || (!id && !params.get('new')))) name = 'puzzlethemes';
  if (app.route !== name) {
    const prev = app.pages[app.route];
    if (prev && prev.deactivate) prev.deactivate();
  }
  app.route = name;
  // An online game is part of Play.
  const navRoute = name === 'game' ? 'home' : name === 'puzzlethemes' ? 'puzzles' : name;
  $$('.site-nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === navRoute));
  $$('.nav-group').forEach((g) => g.classList.toggle('on', !!g.querySelector(`a[data-route="${navRoute}"]`)));
  $('#workspace').classList.toggle('hidden', !BOARD_PAGES.includes(name));
  $('#home').classList.toggle('hidden', name !== 'home');
  $('#puzzles').classList.toggle('hidden', name !== 'puzzlethemes');
  $('#side-puzzle').classList.toggle('hidden', name !== 'puzzles');
  if (name !== 'puzzles') $('#pz-empty').classList.add('hidden');
  if (name !== 'game') $('#challenge').classList.add('hidden');
  $('#side-game').classList.toggle('hidden', name !== 'game');
  $('#openings').classList.toggle('hidden', name !== 'openings');
  $('#rules').classList.toggle('hidden', name !== 'rules');
  $('#browser').classList.toggle('hidden', name !== 'games');
  $('#side-analysis').classList.toggle('hidden', name !== 'analysis');
  $('#side-play').classList.toggle('hidden', name !== 'play');
  $('#side-editor').classList.toggle('hidden', name !== 'editor');
  $('#side-practice').classList.toggle('hidden', name !== 'practice');
  if (name !== 'practice') $('#practice-select').classList.add('hidden');
  $('#workspace').classList.toggle('editing', name === 'editor');
  if (BOARD_PAGES.includes(name)) app.board.resize();
  app.pages[name].activate(params);
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('kairos.theme', t); } catch (e) { /* private mode */ }
  app.board.readColors();
  if (app.pages && app.pages.analysis) app.pages.analysis.renderGraph();
}

function bindKeys() {
  bindCameraKeys(app.board, () => ['analysis', 'play'].includes(app.route)
    || app.route === 'practice' || app.route === 'game' || app.route === 'puzzles' || (app.route === 'editor' && app.pages.editor.tool === 'move'));
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.target.closest('input, textarea, select, dialog, [contenteditable]') || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    // The editor's keys come first: its piece letters include P (pawn).
    if (app.route === 'editor' && app.pages.editor.key(e)) { e.preventDefault(); return; }
    let handled = true;
    // U flips the board (as in the game; F submits). In the editor U is the unicorn's piece
    // letter (the editor takes it above), so there F flips: nothing is submitted there.
    if (k === 'u' || k === 'U' || ((k === 'f' || k === 'F') && app.route === 'editor')) {
      app.board.setFlipped(!app.board.flipped);
    } else if (k === 'p' || k === 'P') app.board.goPresent();
    else if (k === '0') app.board.fit();
    else if (k === '+' || k === '=') app.board.zoomAt(1.25);
    else if (k === '-' || k === '_') app.board.zoomAt(0.8);
    else if (k === '?') $('#dlg-help').showModal();
    else {
      const page = app.pages[app.route];
      handled = !!(page && page.key && page.key(e));
    }
    if (handled) e.preventDefault();
  });
}

/** The Settings dialog: how moves are written (see notation.js). */
function bindSettings() {
  const squares = $('#set-omit-squares'), boards = $('#set-omit-boards');
  const show = () => {
    const s = notationSettings();
    squares.checked = s.omitSourceSquares;
    boards.checked = s.omitSourceBoards;
    // The same move as the settings write it, where a board has one active board.
    const e = { san: '(0T2)Nf3', sanFull: '(0T2)Ng1f3', lone: true };
    $('#set-example').textContent = `Example: ${moveText(e)}`;
  };
  const anim = $('#set-animations'), drag = $('#set-drag'), flip = $('#set-autoflip');
  const showPrefs = () => {
    anim.checked = prefs.animations;
    flip.checked = prefs.autoFlip;
    drag.value = prefs.dragThreshold;
    $('#set-drag-value').textContent = `${prefs.dragThreshold} px`;
  };
  anim.onchange = () => setPref('animations', anim.checked);
  flip.onchange = () => setPref('autoFlip', flip.checked);
  drag.oninput = () => setPref('dragThreshold', drag.value);
  window.addEventListener('prefs-change', showPrefs);
  squares.onchange = () => setNotation('omitSourceSquares', squares.checked);
  boards.onchange = () => setNotation('omitSourceBoards', boards.checked);
  window.addEventListener('notation-change', show);
  $('#btn-settings').onclick = () => { show(); showPrefs(); $('#dlg-settings').showModal(); };
}

/** The published build (version.json, written by scripts/build_pages.sh): its commit, as a link. */
async function showBuild() {
  try {
    const r = await fetch('version.json', { cache: 'no-store' });
    if (!r.ok) return;
    const v = await r.json();
    app.build = v;
    const a = $('#build');
    a.textContent = v.sha.slice(0, 7);
    const when = v.date ? ' · ' + v.date.slice(0, 16).replace('T', ' ') : '';
    const engine = v.engine && v.engine.sha ? `\nEngine: Kairos ${v.engine.sha.slice(0, 7)}` : '';
    a.title = `Build ${v.sha.slice(0, 7)}${when}${v.subject ? '\n' + v.subject : ''}${engine}`;
    if (v.url) a.href = v.url;
    a.classList.remove('hidden');
  } catch (e) { /* a local server has no build info */ }
}

/** The Rules page is static text; its contents links scroll to a section. */
function rulesPage() {
  document.querySelector('.rules-toc').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-sec]');
    if (!a) return;
    e.preventDefault();
    const el = document.getElementById('rules-' + a.dataset.sec);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return { activate() { $('#rules').scrollTop = 0; } };
}

async function main() {
  bindSiteNav();
  bindDialogDismiss();
  sounds.init($('#btn-sound'));
  app.board = new MultiverseView($('#board'));
  app.input = new MoveInput(app.board);
  app.board.onHover = (sq) => {
    const v = app.board.view;
    if (!sq || !v) { $('#coord-chip').textContent = ''; return; }
    const tl = v.timelines.find((t) => t.l === sq.l);
    $('#coord-chip').textContent = `L${tl ? tl.label : sq.l} T${sq.t}${sq.c ? 'b' : 'w'} · ${'abcdefgh'[sq.x]}${sq.y + 1}`;
  };
  $('#tool-fit').onclick = () => app.board.fit();
  $('#tool-present').onclick = () => app.board.goPresent();
  $('#tool-zoom-in').onclick = () => app.board.zoomAt(1.25);
  $('#tool-zoom-out').onclick = () => app.board.zoomAt(0.8);
  $('#tool-flip').onclick = () => {
    app.board.setFlipped(!app.board.flipped);
  };
  $('#btn-theme').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  // Board square colours: brown, blue, green (lichess themes).
  $('#btn-board-theme').onclick = () => {
    const themes = ['brown', 'blue', 'green'];
    const next = themes[(themes.indexOf(document.documentElement.dataset.board) + 1) % themes.length];
    document.documentElement.dataset.board = next;
    store('boardTheme', next);
    app.board.readColors();
    toast(`Board: ${next}`);
  };
  $('#btn-help').onclick = () => $('#dlg-help').showModal();
  bindSettings();
  bindKeys();
  showBuild();
  // The Analysis tab, clicked while already on Analysis, starts over with a new board too.
  document.querySelector('.site-nav a[data-route="analysis"]').addEventListener('click', (e) => {
    if (app.route !== 'analysis') return;
    e.preventDefault();
    app.pages.analysis.fresh();
    toast('New board');
    history.replaceState(null, '', '#/analysis');
  });

  app.server = await serverInfo();
  app.pages = { analysis: new Analysis(app), play: new Play(app), editor: new Editor(app), games: new Games(app), openings: new Openings(app), practice: new Practice(app), home: new Home(app), game: new OnlineGame(app), puzzles: new Puzzles(app), puzzlethemes: new PuzzleThemes(app), rules: rulesPage() };
  try {
    await app.pages.analysis.init();
    setRules(app.pages.analysis.rules);
  } catch (e) {
    console.error(e);
    toast('Could not start the Kairos core: ' + e.message, { error: true, ms: 15000 });
    return;
  }
  await app.pages.play.init();
  app.pages.games.init();
  app.pages.editor.init();
  await app.pages.practice.init();
  await app.pages.puzzles.init();
  app.pages.puzzlethemes.init();
  await app.pages.home.init();
  await app.pages.game.init();
  window.addEventListener('hashchange', route);
  route();
  // Warm up the engine worker in the background.
  app.engine.start().catch((e) => console.warn('engine:', e));
}

main();
window.kairosApp = app;
