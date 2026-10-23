// Time controls for online games and games against Kairos: the choices offered (the server
// accepts only these), labels, and the speed a time control counts as.

/** Minutes per side and increments (s), as infinitechess.org offers them; the 5D per-timeline delay. */
export const MINUTES = [...Array(20).keys()].map((i) => i + 1).concat([25, 30, 35, 40, 45, 60]);
export const INCREMENTS = [...Array(21).keys()].concat([25, 30, 35, 40, 45, 60]);
export const TL_DELAYS = [...Array(11).keys()];

/** Presets: the 5D tournament format first (5 minutes, 3 s of delay per active timeline). */
export const PRESETS = [
  { label: '5 | 3s/TL', title: 'The 5D tournament format: 5 minutes, and each turn a delay of 3 s per active timeline', m: 5, i: 0, tl: 3 },
  { m: 1, i: 2, tl: 0 }, { m: 2, i: 2, tl: 0 }, { m: 3, i: 2, tl: 0 }, { m: 5, i: 2, tl: 0 },
  { m: 8, i: 3, tl: 0 }, { m: 10, i: 4, tl: 0 }, { m: 15, i: 5, tl: 0 }, { m: 20, i: 6, tl: 0 },
];

/** "5+3", "5 | 3s/TL", "5+2 · 3s/TL" or "∞" for {base_ms, inc_ms, delay_ms, tl_delay_ms}. */
export function tcLabel(t) {
  if (!t || t.base_ms == null) return '∞';
  const m = +(t.base_ms / 60000).toFixed(2), i = (t.inc_ms || 0) / 1000, tl = (t.tl_delay_ms || 0) / 1000, d = (t.delay_ms || 0) / 1000;
  if (tl && !i && !d) return `${m} | ${tl}s/TL`;
  return [`${m}+${i}`, d ? `${d}s delay` : '', tl ? `${tl}s/TL` : ''].filter(Boolean).join(' · ');
}

/** The full wording, for a tooltip. */
export function tcText(t) {
  if (!t || t.base_ms == null) return 'Unlimited time';
  const parts = [`${+(t.base_ms / 60000).toFixed(2)} minutes`, `${(t.inc_ms || 0) / 1000} s increment`];
  if (t.delay_ms) parts.push(`${t.delay_ms / 1000} s delay each turn`);
  if (t.tl_delay_ms) parts.push(`${t.tl_delay_ms / 1000} s delay per active timeline each turn`);
  return parts.join(', ');
}

/** Bullet, Blitz, Rapid or Classical (lichess's estimate base + 40 × increment; delays count as increment). */
export function speed(t) {
  if (!t || t.base_ms == null) return 'Unlimited';
  const est = t.base_ms / 1000 + 40 * ((t.inc_ms || 0) + (t.delay_ms || 0) + 2 * (t.tl_delay_ms || 0)) / 1000;
  return est < 180 ? 'Bullet' : est < 480 ? 'Blitz' : est < 1500 ? 'Rapid' : 'Classical';
}

/** "4:58", "1:02:03" or "0:07.3" (tenths under 10 s) for ms left. */
export function clockText(ms) {
  ms = Math.max(0, ms);
  if (ms < 10000) return `0:${String(Math.floor(ms / 1000)).padStart(2, '0')}.${Math.floor((ms % 1000) / 100)}`;
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
