/** A standalone start position retaining every historical board and branched timeline. */
export function positionFromView(view) {
  const label = (l) => view.even ? (l >= 0 ? `+${l}` : `-${-l - 1}`) : String(l);
  const boards = view.boards.map(([l, t, c, fen]) => `[${fen}:${label(l)}:${t}:${c ? 'b' : 'w'}]`);
  const promos = view.promotions && view.promotions !== 'Q' ? ` promotions ${view.promotions}` : '';
  return `size ${view.size.join('x')} ${view.even ? 'even' : 'odd'}${promos} fen ${boards.join(' ')}`;
}

/**
 * Where playing on from `position` goes, by mode (computer | friend | online): the home page's
 * game options with that start.
 */
export function playHref(app, position, mode = 'computer') {
  return `#/?play=${mode}&position=${encodeURIComponent(position)}`;
}

/** "Continue from here" (as lichess): ask how to play on from `position`, then go there. */
export function continueFrom(app, position) {
  const dialog = document.getElementById('dlg-continue');
  for (const a of dialog.querySelectorAll('a[data-mode]')) {
    a.href = playHref(app, position, a.dataset.mode);
    a.onclick = () => dialog.close();
  }
  dialog.showModal();
}
