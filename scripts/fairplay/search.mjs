// Kairos's search output as the fair-play scripts read it (detect.mjs, collect.mjs).

/** Kairos's info lines of one search as its final lines and its best action at each depth. */
export function parseSearch(lines) {
  const byDepth = new Map(); // depth -> [line per multipv]
  for (const l of lines) {
    const m = /^depth (\d+) multipv (\d+) score (cp (-?\d+)|mate (-?\d+))(?: wdl (\d+) (\d+) (\d+))?.* pv (.*)$/.exec(l);
    if (!m) continue;
    const depth = +m[1], k = +m[2];
    const action = m[9].split(' submit')[0].trim();
    const line = { action, cp: m[4] != null ? +m[4] : null, mate: m[5] != null ? +m[5] : null,
      wdl: m[6] != null ? [+m[6], +m[7], +m[8]] : null };
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth)[k - 1] = line;
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  if (!depths.length) return null;
  const width = Math.max(...depths.map((d) => byDepth.get(d).filter(Boolean).length));
  // The deepest depth with every line; else the deepest.
  const full = [...depths].reverse().find((d) => byDepth.get(d).filter(Boolean).length === width);
  const lines_ = (byDepth.get(full ?? depths[depths.length - 1]) || []).filter(Boolean);
  const topByDepth = depths.map((d) => byDepth.get(d)[0] && byDepth.get(d)[0].action).filter(Boolean);
  return { lines: lines_, topByDepth };
}
