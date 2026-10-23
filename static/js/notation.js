// How moves are written on screen (the Settings dialog), after 5dcol's 5dpgn options. The rules
// core sends each action twice, short and with every move's whole source square, and says
// whether the side to move had a single board to play on; this picks and trims the text.
import { store } from './util.js';

const DEFAULTS = {
  // Leave out the source file and rank where the move is clear without them (as the move list
  // has always done); off writes the whole source square: (0T2)Ng1f3.
  omitSourceSquares: true,
  // Leave out the source board when the side to move has one board to play on: Nf3, not (0T2)Nf3.
  omitSourceBoards: false,
};

const settings = { ...DEFAULTS, ...(store('notation') || {}) };

export function notationSettings() { return { ...settings }; }

/** Change a notation setting, remember it, and tell the pages to redraw their moves. */
export function setNotation(key, value) {
  settings[key] = !!value;
  store('notation', settings);
  window.dispatchEvent(new Event('notation-change'));
}

/**
 * An action as the settings write it. `n` has `san`, and `sanFull` and `lone` from the rules
 * core (a node of the tree, a draft's moves, or a line of the engine).
 */
export function moveText(n) {
  let text = (!settings.omitSourceSquares && n.sanFull) || n.san || '';
  if (settings.omitSourceBoards && n.lone) {
    // Only a move's own board: `(0T2)Nf3`, not the target board after `>` or a branch note `(>L1)`.
    text = text.split(' ').map((tok) => tok.replace(/^\([^)]*T\d+\)/, '')).join(' ');
  }
  return text;
}
