// Fair play's scoring, after infinitechess.org's detector (its CHEAT_DETECTION.md): each action a
// player made in a rated game becomes a piece of evidence (how hard the position was, and whether
// they found a good action and Kairos's own choice), and a player's evidence feeds a betting
// score: how many times likelier their recent actions are if they use an engine than if they are
// an honest player as strong as their rating plausibly allows. Pure: the detector
// (scripts/fairplay/detect.mjs) and the admins' review page (review.js) share it.
//
// CALIBRATION: GOOD_LOSS, MODEL and CASE_LOG_SCORE are fitted (scripts/fairplay/fit.mjs) on 222
// rated 5D games between the strongest community players, 2021-2025, before any 5D engine was
// strong, analysed as the detector does, with Kairos's own actions in the same positions at a
// cheater's budgets (docs/FAIR_PLAY.md). Refit on this site's games once there are enough.

/**
 * Win-probability loss within which an action counts as good. Of the thresholds tried (2, 3, 5
 * and 8%), 3% catches part-time cheaters soonest: at it, the strong players' actions are 34% the
 * search's top, 18% good and 48% misses, Kairos's 65% / 25% / 10% (its win/draw/loss wobbles at
 * this search's depth, so even its own actions miss sometimes).
 */
export const GOOD_LOSS = 0.03;
/** Positions this one-sided are left out: nearly every action keeps them so. */
export const DECIDED = 0.97;
/** A "shallow" look at the position: its best action at this depth. */
export const SHALLOW_DEPTH = 3;
/** A best action that only settles this deep is a deep find. */
export const DEEP_FIND_DEPTH = 7;
/** Lines searched per position, and the fixed search (nodes, single thread). */
export const MULTIPV = 5;
export const NODES = 800_000;

/**
 * The natural log of the score that opens a case: ten times the highest an honest history reaches
 * (every real player's, 99.9% of 30-game histories drawn from all the games, 99.9% of each
 * player's own games reordered), about 71 to 1. At it, cheaters who take every action from
 * Kairos are caught in a median 3 games, and those who take half of them within 30 games 71% of
 * the time. A case is only a review for the admins: nothing is ever done automatically.
 */
export const CASE_LOG_SCORE = 4.26;
/** A case needs evidence from at least this many games. */
export const MIN_GAMES = 3;
/** Games older than this no longer count. */
export const MAX_AGE_DAYS = 183;

/**
 * The bet (see CALIBRATION above). The honest ceiling is the same for every rating: the strongest
 * player's own offset in the data plus a margin, so everyone is compared with the best honest
 * players.
 */
export const MODEL = {
  skillCeiling: { base: 0.673, perRating: 0, margin: 0 },
  cheatFractions: [0.1, 0.25, 0.5, 1],
  honestGoodWeights: [1.113, -1.145, -0.942, -0.358, -0.957, -0.238, 0.76, 0.6],
  honestTopRates: [1, 0.552, 0.438, 0.527, 0.228],
  honestTopMargin: 0.05,
  engineGoodWeights: [3.955, -1.133, -0.162, 0.253, -1.347, -0.922, -0.296, -0.563],
  engineTopWeights: [0.597, 5.078, 1.213, 0.658, -0.373, -1.302, -0.312, -0.487],
};

// ---------------------------------------------------------------- evidence

/** One line's value for the side to move, from Kairos's win/draw/loss (per mille). */
export function lineValue(line) {
  if (line.wdl) return (line.wdl[0] + line.wdl[1] / 2) / 1000;
  if (line.mate != null) return line.mate > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.00368208 * line.cp));
}

/** An action's moves as a set (their order within the action doesn't matter). */
export function sameAction(a, b) {
  const set = (s) => s.trim().split(/\s+/).sort().join(' ');
  return set(a) === set(b);
}

/**
 * Evidence for the actions of the side moving at plies of `parity` (0 White's first action...):
 * `positions[k]` is the analysis of the position before action k ({lines: [{action, wdl|cp|mate,
 * captures, travel}], topByDepth, inCheck, forced}), the last one the position after the game's
 * last action; `actions[k]` the action played.
 */
export function gather(positions, actions, parity, goodLoss = GOOD_LOSS) {
  const out = [];
  for (let ply = parity; ply < actions.length; ply += 2) {
    const j = judge(positions[ply], positions[ply + 1], actions[ply], goodLoss);
    if (j) out.push({ ply, ...j });
  }
  return out;
}

/** The action played from `before` to `after`, judged; undefined when it says nothing. */
export function judge(before, after, action, goodLoss = GOOD_LOSS) {
  if (!before || before.failed || before.forced || !before.lines || !before.lines.length) return undefined;
  const values = before.lines.map(lineValue);
  const best = values[0];
  if (best > DECIDED || best < 1 - DECIDED) return undefined;
  const rank = before.lines.findIndex((l) => sameAction(l.action, action));
  let value;
  if (rank >= 0) value = values[rank];
  else {
    // Outside the lines: from the position after it, no better than the last line.
    if (!after || after.failed || !after.lines || !after.lines.length) return undefined;
    value = Math.min(1 - lineValue(after.lines[0]), values[values.length - 1]);
  }
  const loss = best - value;
  const outcome = loss > goodLoss ? 'miss' : rank === 0 ? 'top' : 'good';
  return { outcome, loss: Math.round(loss * 1000) / 1000, difficulty: difficultyOf(before, values, goodLoss) };
}

function difficultyOf(p, values, goodLoss) {
  const isGood = (action) => {
    const r = p.lines.findIndex((l) => sameAction(l.action, action));
    return r >= 0 && values[0] - values[r] <= goodLoss;
  };
  const best = p.lines[0].action;
  const tops = p.topByDepth || [];
  const shallow = tops[Math.min(SHALLOW_DEPTH, tops.length) - 1];
  let lastWrong = 0;
  tops.forEach((a, i) => { if (!sameAction(a, best)) lastWrong = i + 1; });
  return {
    goodMoves: values.filter((v) => values[0] - v <= goodLoss).length,
    shallowFinds: shallow !== undefined && isGood(shallow),
    deepFind: lastWrong + 1 >= DEEP_FIND_DEPTH,
    bestCaptures: !!p.lines[0].captures,
    inCheck: !!p.inCheck,
    // Not in the model yet (5D's own, for its calibration): the best action crosses boards.
    bestTravels: !!p.lines[0].travel,
  };
}

// ---------------------------------------------------------------- the bet

export function features(d) {
  return [1, d.goodMoves === 1 ? 1 : 0, d.goodMoves === 2 ? 1 : 0, d.goodMoves === 3 || d.goodMoves === 4 ? 1 : 0,
    d.shallowFinds ? 0 : 1, d.deepFind ? 1 : 0, d.bestCaptures ? 1 : 0, d.inCheck ? 1 : 0];
}

function logistic(w, x, offset = 0) {
  let z = offset;
  for (let i = 0; i < w.length; i++) z += w[i] * x[i];
  return 1 / (1 + Math.exp(-z));
}

/**
 * The strongest an honest player of this rating plausibly is, in logits (rating + 2 deviations).
 * The fitted model sets perRating to 0: the same ceiling, the best players', for every rating.
 */
export function skillCeiling(rating, rd, model = MODEL) {
  const { base, perRating, margin } = model.skillCeiling;
  return base + (perRating * (rating + 2 * rd - 1500)) / 300 + margin;
}

/** One action's log likelihood ratios, one per cheating fraction. */
export function moveLogRatios(ev, ceiling, model = MODEL) {
  const x = features(ev.difficulty);
  const honestGood = logistic(model.honestGoodWeights, x, ceiling);
  const engineGood = logistic(model.engineGoodWeights, x);
  if (engineGood <= honestGood) return model.cheatFractions.map(() => 0);
  const honestTop = Math.min(1, model.honestTopRates[Math.min(ev.difficulty.goodMoves, 5) - 1] + model.honestTopMargin);
  const engineTop = engineGood * logistic(model.engineTopWeights, x);
  const split = engineTop / engineGood > honestTop;
  return model.cheatFractions.map((f) => {
    if (ev.outcome === 'miss') return Math.log(((1 - f) * (1 - honestGood) + f * (1 - engineGood)) / (1 - honestGood));
    if (!split) return Math.log(((1 - f) * honestGood + f * engineGood) / honestGood);
    if (ev.outcome === 'top') return Math.log(((1 - f) * honestGood * honestTop + f * engineTop) / (honestGood * honestTop));
    return Math.log(((1 - f) * honestGood * (1 - honestTop) + f * (engineGood - engineTop)) / (honestGood * (1 - honestTop)));
  });
}

/** A game's log likelihood ratios (sums over its actions), per fraction. */
export function gameLogRatios(evidence, rating, rd, model = MODEL) {
  const ceiling = skillCeiling(rating, rd, model);
  const sums = model.cheatFractions.map(() => 0);
  for (const ev of evidence) moveLogRatios(ev, ceiling, model).forEach((r, i) => (sums[i] += r));
  return sums;
}

/** The score now: the best over every run of games ending with the latest (oldest first). Its log. */
export function bestRunLogScore(games) {
  let best = 0;
  const sums = games[0] ? games[0].map(() => 0) : [];
  for (let start = games.length - 1; start >= 0; start--) {
    games[start].forEach((r, i) => (sums[i] += r));
    const max = Math.max(...sums);
    const log = max + Math.log(sums.reduce((t, s) => t + Math.exp(s - max), 0) / sums.length);
    best = Math.max(best, log);
  }
  return best;
}

/** One action's single number for display: its log ratio averaged over the fractions' bets. */
export function moveScore(ev, rating, rd, model = MODEL) {
  const r = moveLogRatios(ev, skillCeiling(rating, rd, model), model);
  const max = Math.max(...r);
  return max + Math.log(r.reduce((t, s) => t + Math.exp(s - max), 0) / r.length);
}

// ---------------------------------------------------------------- the page's signals
// What the player's page measured (static/js/fairplay.js), joined to the evidence. These rules
// compare a player with themself, so their strength and the search's noise cancel out: a player
// whose actions match the engine much more often on the turns they spent away from the game's
// page, or whose think times are as even as a program's, gets a case. The old games the model is
// fitted on have no such measurements, so these thresholds are set by hand, conservatively, and
// every case keeps the numbers that opened it (for tuning on this site's own games).

/** A turn is "away" when the game's page was hidden or out of focus this long during it. */
export const AWAY_MS = 3000;
/** Engine matches on away turns: at least this many away turns, and the gap and its z-score. */
export const AWAY = { minAway: 10, minGap: 0.25, minZ: 3 };
/** Even think times: at least this many timed actions, their mean, and their coefficient of variation. */
export const TIMING = { minActions: 30, minMeanMs: 2000, maxCv: 0.25 };
/** Turns of one game whose live position the player's own analysis board showed on another device. */
export const DEVICE_MATCHES = 2;

/** The evidence of one game with each action's page measurements (`signals` by ply). */
export function withSignals(evidence, signals) {
  return evidence.map((e) => {
    const s = (signals && signals[e.ply]) || {};
    const away = Math.max(s.hidden_ms || 0, s.blurred_ms || 0);
    return { ...e, away_ms: s.unmeasured || s.turn_ms == null ? null : away, turn_ms: s.turn_ms ?? null };
  });
}

/** Engine-first actions on away turns against the others, over all the evidence given. */
export function awayStats(evidence) {
  const timed = evidence.filter((e) => e.away_ms != null);
  const away = timed.filter((e) => e.away_ms >= AWAY_MS), present = timed.filter((e) => e.away_ms < AWAY_MS);
  const top = (list) => list.filter((e) => e.outcome === 'top').length;
  const a = away.length, p = present.length, ta = top(away), tp = top(present);
  const rateA = a ? ta / a : null, rateP = p ? tp / p : null;
  let z = null;
  if (a && p) {
    const pooled = (ta + tp) / (a + p);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a + 1 / p));
    z = se > 0 ? (rateA - rateP) / se : 0;
  }
  return { away: a, present: p, topAway: rateA, topPresent: rateP, z };
}

/** Think times (the turns the page measured): count, mean and coefficient of variation. */
export function timingStats(evidence) {
  const t = evidence.map((e) => e.turn_ms).filter((x) => x != null);
  if (t.length < 2) return { actions: t.length, mean: null, cv: null };
  const mean = t.reduce((s, x) => s + x, 0) / t.length;
  const sd = Math.sqrt(t.reduce((s, x) => s + (x - mean) ** 2, 0) / (t.length - 1));
  return { actions: t.length, mean, cv: mean > 0 ? sd / mean : null };
}

/** The signal rules that a player's recent evidence (all games together) breaks: [{reason, detail}]. */
export function signalFindings(evidence) {
  const out = [];
  const a = awayStats(evidence);
  if (a.away >= AWAY.minAway && a.topAway - a.topPresent >= AWAY.minGap && a.z >= AWAY.minZ) out.push({ reason: 'away', detail: a });
  const t = timingStats(evidence);
  if (t.actions >= TIMING.minActions && t.mean >= TIMING.minMeanMs && t.cv < TIMING.maxCv) out.push({ reason: 'timing', detail: t });
  return out;
}
