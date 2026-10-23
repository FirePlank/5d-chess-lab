// Display and input preferences (the Settings dialog), remembered in the browser. The move
// notation options are in notation.js.
import { store } from './util.js';

const DEFAULTS = {
  // Boards slide in and out as an action adds or removes them, and the camera glides to follow.
  animations: true,
  // How far (px) the pointer must move with a button down before it pans (or draws an arrow):
  // below that it is a click.
  dragThreshold: 5,
  // On the analysis board, turn the board to the side to move whenever the position changes.
  autoFlip: false,
};

const RANGE = { dragThreshold: [0, 24] };

export const prefs = { ...DEFAULTS, ...(store('prefs') || {}) };
for (const [k, [lo, hi]] of Object.entries(RANGE)) {
  const v = Number(prefs[k]);
  prefs[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULTS[k];
}

/** Change a preference, remember it, and tell the pages. */
export function setPref(key, value) {
  const range = RANGE[key];
  prefs[key] = typeof DEFAULTS[key] === 'boolean' ? !!value
    : range ? Math.min(range[1], Math.max(range[0], Number(value) || 0)) : value;
  store('prefs', prefs);
  window.dispatchEvent(new Event('prefs-change'));
}
