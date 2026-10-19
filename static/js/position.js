/** A standalone start position retaining every historical board and branched timeline. */
export function positionFromView(view) {
  const label = (l) => view.even ? (l >= 0 ? `+${l}` : `-${-l - 1}`) : String(l);
  const boards = view.boards.map(([l, t, c, fen]) => `[${fen}:${label(l)}:${t}:${c ? 'b' : 'w'}]`);
  return `size ${view.size.join('x')} ${view.even ? 'even' : 'odd'} fen ${boards.join(' ')}`;
}
