// Fit fair play's model (static/js/fairplay-score.js, MODEL, GOOD_LOSS and CASE_LOG_SCORE) on the
// data scripts/fairplay/collect.mjs gathers: human games, honest by every account (2021-2025, before
// any 5D engine was strong), analysed with the detector's own search, and Kairos's actions on the same
// positions at a cheater's budgets.
//
//   node scripts/fairplay/fit.mjs <data prefix, e.g. target/fairplay/human.jsonl>
//
// For each good-action threshold it tries:
// - fits, by logistic regression, how often honest players and Kairos find a good action, how often
//   Kairos's good action is its top one, and honest players' top rate among good actions;
// - sets the honest ceiling (the logit offset every honest player is granted) at the strongest
//   player's own offset in the data, plus a margin: the bet is against the best honest players;
// - scores every game with a model fitted without it (5 folds), and sets the case line above every
//   real player's history and above 99.9% of 30-game histories drawn from all honest games, times ten;
// - simulates cheaters (all, half or a quarter of their actions from Kairos) and reports how many
//   games they last.
// It prints the chosen threshold, model and case line, and the report.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { judge, features, gameLogRatios, bestRunLogScore } from '../../static/js/fairplay-score.js';

const prefix = process.argv[2];
const games = readdirSync(dirname(prefix)).filter((f) => f.startsWith(basename(prefix) + '.'))
  .flatMap((f) => readFileSync(join(dirname(prefix), f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
const THRESHOLDS = [0.02, 0.03, 0.05, 0.08];
const FOLDS = 5;
const CHEAT_FRACTIONS = [1, 0.5, 0.25];
const HISTORY = 30;

// A deterministic generator, so a fit is repeatable.
let seed = 12345;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rand() * a.length)];
const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Every game's evidence: the people's actions and Kairos's, per side. */
function evidenceOf(goodLoss) {
  return games.map((g, gi) => {
    const P = g.positions;
    const human = [[], []], engine = [[], []];
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      if (!p || p.failed) continue;
      if (p.played) {
        const j = judge(p, P[k + 1], p.played, goodLoss);
        if (j) human[k % 2].push(j);
      }
      if (p.cheat) {
        const j = judge(p, p.cheat.after ? { lines: [p.cheat.after] } : null, p.cheat.action, goodLoss);
        if (j) engine[k % 2].push({ ...j, nodes: p.cheat.nodes });
      }
    }
    const name = (side) => (side ? g.black : g.white) || `${g.file}:${side}`;
    return { file: g.file, fold: hash(g.file) % FOLDS, date: g.date || '', players: [name(0), name(1)], human, engine };
  });
}

// ---------------------------------------------------------------- logistic regression
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

/** Weights for P(y | features), Newton's method with a light L2 penalty (not on the bias). */
function logistic(rows, ys, lambda = 1) {
  const d = rows[0].length;
  let w = new Array(d).fill(0);
  for (let it = 0; it < 30; it++) {
    const g = new Array(d).fill(0), H = [...Array(d)].map(() => new Array(d).fill(0));
    rows.forEach((x, i) => {
      const p = sigmoid(x.reduce((s, v, j) => s + v * w[j], 0));
      for (let a = 0; a < d; a++) {
        g[a] += (ys[i] - p) * x[a];
        for (let b = 0; b < d; b++) H[a][b] -= p * (1 - p) * x[a] * x[b];
      }
    });
    for (let a = 1; a < d; a++) { g[a] -= lambda * w[a]; H[a][a] -= lambda; }
    const step = solve(H, g.map((v) => -v));
    w = w.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return w.map((v) => Math.round(v * 1000) / 1000);
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

/** One player's own logit offset against the pooled honest weights (their strength). */
function playerOffset(evs, w) {
  let o = 0;
  for (let it = 0; it < 30; it++) {
    let g = 0, h = 0;
    for (const e of evs) {
      const p = sigmoid(features(e.difficulty).reduce((s, v, j) => s + v * w[j], 0) + o);
      g += (e.outcome !== 'miss' ? 1 : 0) - p;
      h -= p * (1 - p);
    }
    g -= 0.1 * o; h -= 0.1; // a weak pull to 0 for players with few actions
    o -= g / h;
  }
  return o;
}

/** The model from the training games. */
function fitModel(train) {
  const hum = train.flatMap((g) => [...g.human[0], ...g.human[1]]);
  const eng = train.flatMap((g) => [...g.engine[0], ...g.engine[1]]);
  const X = (evs) => evs.map((e) => features(e.difficulty));
  const good = (evs) => evs.map((e) => (e.outcome !== 'miss' ? 1 : 0));
  const honestGoodWeights = logistic(X(hum), good(hum));
  const engineGoodWeights = logistic(X(eng), good(eng));
  const engGood = eng.filter((e) => e.outcome !== 'miss');
  const engineTopWeights = logistic(X(engGood), engGood.map((e) => (e.outcome === 'top' ? 1 : 0)));
  const honestTopRates = [1, 2, 3, 4, 5].map((n) => {
    const evs = hum.filter((e) => e.outcome !== 'miss' && Math.min(e.difficulty.goodMoves, 5) === n);
    return evs.length ? Math.round((evs.filter((e) => e.outcome === 'top').length / evs.length) * 1000) / 1000 : 1 / n;
  });
  // The strongest player's own offset (players with enough actions), plus a margin.
  const byPlayer = new Map();
  for (const g of train) for (const side of [0, 1]) {
    const k = g.players[side];
    if (!byPlayer.has(k)) byPlayer.set(k, []);
    byPlayer.get(k).push(...g.human[side]);
  }
  const offsets = [...byPlayer.entries()].filter(([, e]) => e.length >= 150).map(([k, e]) => [k, playerOffset(e, honestGoodWeights)]);
  const strongest = offsets.reduce((m, o) => (o[1] > m[1] ? o : m), ['', 0]);
  return {
    skillCeiling: { base: Math.round((strongest[1] + 0.25) * 1000) / 1000, perRating: 0, margin: 0 },
    cheatFractions: [0.1, 0.25, 0.5, 1],
    honestGoodWeights, honestTopRates, honestTopMargin: 0.05, engineGoodWeights, engineTopWeights,
    _strongest: strongest, _offsets: offsets.sort((a, b) => b[1] - a[1]).slice(0, 8),
  };
}

const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function evaluate(goodLoss) {
  const ev = evidenceOf(goodLoss);
  // Every game scored by a model that never saw it.
  const honestGames = [], cheatPool = [], humanPool = [], sizes = [];
  for (let f = 0; f < FOLDS; f++) {
    const model = fitModel(ev.filter((g) => g.fold !== f));
    for (const g of ev.filter((x) => x.fold === f)) {
      for (const side of [0, 1]) {
        const h = g.human[side];
        if (!h.length) continue;
        honestGames.push({ player: g.players[side], date: g.date, file: g.file, ratios: gameLogRatios(h, 1500, 0, model) });
        sizes.push(h.length);
        for (const e of h) humanPool.push({ e, model });
        for (const e of g.engine[side]) cheatPool.push({ e, model });
      }
    }
  }
  // Real players' histories, oldest first: the highest score each ever reaches.
  const byPlayer = new Map();
  for (const g of honestGames) {
    if (!byPlayer.has(g.player)) byPlayer.set(g.player, []);
    byPlayer.get(g.player).push(g);
  }
  const playerMax = [...byPlayer.entries()].map(([p, gs]) => {
    gs.sort((a, b) => (a.date + a.file).localeCompare(b.date + b.file));
    let max = 0;
    for (let n = 1; n <= gs.length; n++) max = Math.max(max, bestRunLogScore(gs.slice(Math.max(0, n - 40), n).map((g) => g.ratios)));
    return [p, gs.length, max];
  }).sort((a, b) => b[2] - a[2]);
  // Histories drawn from every honest game.
  const drawn = [];
  for (let i = 0; i < 20000; i++) {
    const gs = [];
    let max = 0;
    for (let n = 0; n < HISTORY; n++) { gs.push(pick(honestGames).ratios); max = Math.max(max, bestRunLogScore(gs)); }
    drawn.push(max);
  }
  const line = Math.max(playerMax[0][2], q(drawn, 0.999)) + Math.log(10);
  // Cheaters: each judged action from Kairos with probability f, else a person's.
  const power = CHEAT_FRACTIONS.map((f) => {
    const caught = [];
    for (let i = 0; i < 2000; i++) {
      const gs = [];
      let at = null;
      for (let n = 1; n <= HISTORY && at == null; n++) {
        const size = pick(sizes);
        const sums = [0, 0, 0, 0];
        for (let a = 0; a < size; a++) {
          const { e, model } = rand() < f ? pick(cheatPool) : pick(humanPool);
          // Each action's own out-of-fold model, as gameLogRatios would give it.
          gameLogRatios([e], 1500, 0, model).forEach((r, j) => (sums[j] += r));
        }
        gs.push(sums);
        if (n >= 3 && bestRunLogScore(gs) >= line) at = n;
      }
      caught.push(at ?? Infinity);
    }
    return { f, median: q(caught, 0.5), within10: caught.filter((n) => n <= 10).length / caught.length, within30: caught.filter((n) => n <= 30).length / caught.length };
  });
  const rate = (pool, o) => pool.filter((x) => x.e.outcome === o).length / pool.length;
  return {
    goodLoss, model: fitModel(ev), line, playerMax: playerMax.slice(0, 5), drawn999: q(drawn, 0.999), power,
    rates: { human: { top: rate(humanPool, 'top'), good: rate(humanPool, 'good'), miss: rate(humanPool, 'miss'), n: humanPool.length },
      engine: { top: rate(cheatPool, 'top'), good: rate(cheatPool, 'good'), miss: rate(cheatPool, 'miss'), n: cheatPool.length } },
  };
}

console.log(`${games.length} games`);
const results = THRESHOLDS.map((t) => {
  const r = evaluate(t);
  const fmt = (x) => (x == null ? '-' : x.toFixed(3));
  console.log(`\ngood loss ${t}: line ln ${r.line.toFixed(2)} (x${Math.exp(r.line).toExponential(1)}); top honest players ${r.playerMax.map(([p, n, m]) => `${p} (${n}) ${m.toFixed(1)}`).join(', ')}; drawn 99.9% ${r.drawn999.toFixed(2)}`);
  console.log(`  rates: people ${fmt(r.rates.human.top)} top ${fmt(r.rates.human.good)} good ${fmt(r.rates.human.miss)} miss (${r.rates.human.n}); Kairos ${fmt(r.rates.engine.top)} / ${fmt(r.rates.engine.good)} / ${fmt(r.rates.engine.miss)} (${r.rates.engine.n})`);
  for (const p of r.power) console.log(`  cheating ${p.f}: median ${p.median} games, caught within 10 games ${(p.within10 * 100).toFixed(0)}%, within 30 ${(p.within30 * 100).toFixed(0)}%`);
  console.log(`  strongest players' offsets: ${r.model._offsets.map(([p, o]) => `${p} ${o.toFixed(2)}`).join(', ')}`);
  return r;
});
// The threshold that catches half-time cheaters soonest (then full-time ones).
const best = results.reduce((a, b) => {
  const k = (r) => [r.power[1].within30, r.power[1].within10, r.power[0].within10];
  const ka = k(a), kb = k(b);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] > ka[i] ? b : a;
  return a;
});
const { _strongest, _offsets, ...model } = best.model;
console.log(`\nchosen: GOOD_LOSS = ${best.goodLoss}; CASE_LOG_SCORE = ${best.line.toFixed(2)}`);
console.log('MODEL = ' + JSON.stringify(model, null, 2));
