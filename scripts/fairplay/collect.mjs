// Fair play's calibration data (docs/FAIR_PLAY.md, "Calibration"): human games analysed with the
// detector's own search, and, on the same positions, the actions Kairos plays at the budgets a
// cheater would give it on the analysis board, so that scripts/fairplay/fit.mjs can fit how
// often honest players and engine users find good and top actions.
//
//   node scripts/fairplay/collect.mjs <out.jsonl> <dir of 5dpgn files> [worker] [workers] [games]
//
// Run one process per core (worker 0..workers-1); each appends one JSON line per game to
// <out>.<worker> and skips the games already there, so a stopped run resumes. Per position it
// keeps everything the evidence is computed from (every line's value, the best action at each
// depth, check, capture, travel), not the evidence itself: the fit can then try other thresholds
// without searching again.
import { readFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCore } from '../../tests/core.mjs';
import { NODES, MULTIPV } from '../../static/js/fairplay-score.js';
import { parseSearch } from './search.mjs';

const [out, dir, worker = '0', workers = '1', maxGames = '1000000'] = process.argv.slice(2);
const SEARCH_CAP_MS = 60000;
/** The analysis board's budgets a cheater might use (single-thread nodes: about 1, 3 and 6 s of a 4-thread browser). */
const CHEAT_NODES = [200_000, 600_000, 1_500_000];
/** A cheater's action every this many positions (the searches cost more than the detector's). */
const CHEAT_EVERY = 3;
/** Positions after this many actions are left out (the games' ends are mostly decided anyway). */
const MAX_ACTIONS = +(process.env.MAX_ACTIONS || 40);

// Two cores: the detector's, and the cheater's (its own hash, as on the cheater's own page).
let info = [];
const detector = await loadCore({ onInfo: (l) => info.push(l) });
const cheater = await loadCore({ onInfo: () => {} });
const call = (k, req) => {
  const r = k.call(req);
  if (!r.ok) throw new Error(r.error);
  return r;
};
call(detector, { cmd: 'set_hash', mb: 64 });
call(cheater, { cmd: 'set_hash', mb: 64 });

function analyse(position, newGame) {
  info = [];
  call(detector, { cmd: 'search', position, nodes: NODES, movetime: SEARCH_CAP_MS, multiPV: MULTIPV, skillLevel: 8, book: false, newGame });
  return parseSearch(info);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.5dpgn')).sort()
  .filter((f, i) => i % +workers === +worker).slice(0, +maxGames);
const file = `${out}.${worker}`;
const done = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).file) : []);

for (const f of files) {
  if (done.has(f)) continue;
  const text = readFileSync(join(dir, f), 'utf8');
  const r = detector.call({ cmd: 'load', text });
  if (!r.ok || r.meta.variant !== 'Standard - Turn Zero') continue;
  const ids = r.mainline;
  const positions = [];
  const n = Math.min(ids.length - 1, MAX_ACTIONS);
  for (let k = 0; k <= n; k++) {
    const view = call(detector, { cmd: 'view', node: ids[k], draft: [] }).view;
    if (view.status && view.status !== 'playing') { positions.push({ failed: true }); continue; }
    const s = analyse(view.position, k === 0);
    if (!s || !s.lines.length) { positions.push({ failed: true }); continue; }
    const p = { lines: s.lines.map((l) => ({ action: l.action, wdl: l.wdl, cp: l.cp, mate: l.mate })), topByDepth: s.topByDepth,
      inCheck: view.checks.length > 0, forced: s.lines.length === 1 };
    // The best action's board facts.
    try {
      const san = call(detector, { cmd: 'line_san', node: ids[k], line: s.lines[0].action + ' submit' }).actions[0];
      p.lines[0].captures = /x/.test(san ? san.san : '');
    } catch (e) { p.lines[0].captures = false; }
    p.lines[0].travel = /\)[a-h]\d\(/.test(s.lines[0].action);
    if (k < n) p.played = r.tree.nodes[ids[k + 1]].lan;
    // A cheater's action here, and its value when it is outside the lines.
    if (k % CHEAT_EVERY === (+worker % CHEAT_EVERY) && !p.forced) {
      const nodes = CHEAT_NODES[(k / CHEAT_EVERY + ids.length) % CHEAT_NODES.length | 0];
      const action = String(call(cheater, { cmd: 'search', position: view.position, nodes, movetime: SEARCH_CAP_MS, multiPV: 1, skillLevel: 8, book: false, newGame: false }).bestmove || '');
      if (action) {
        p.cheat = { nodes, action };
        if (!p.lines.some((l) => sameSet(l.action, action))) {
          // The detector's look at the position after it (as the evidence does for an action outside the lines).
          const after = analyse(`${view.position}${/ moves /.test(view.position) ? '' : ' moves'} ${action} submit`, false);
          p.cheat.after = after && after.lines[0] ? { wdl: after.lines[0].wdl, cp: after.lines[0].cp, mate: after.lines[0].mate } : null;
        }
      }
    }
    positions.push(p);
  }
  const header = (name) => (r.meta.headers.find(([k]) => k === name) || [])[1] || null;
  appendFileSync(file, JSON.stringify({ file: f, white: header('White'), black: header('Black'), date: header('Date'),
    event: header('OriginalEvent') || header('Event'), positions }) + '\n');
}

function sameSet(a, b) {
  const set = (s) => s.trim().split(/\s+/).sort().join(' ');
  return set(a) === set(b);
}
