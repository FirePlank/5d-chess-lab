/** A separate rules tree: browsing theory never changes an analysis or a live game. */
export class OpeningTree {
  constructor(rules) { this.rules = rules; }
  load(variant, moves = []) {
    this.start = this.rules.call({ cmd: 'new', position: variant }).tree.start;
    this.path = [{ node: 0 }];
    for (const lan of moves) {
      const parent = this.path.at(-1).node;
      const move = this.rules.call({ cmd: 'book', node: parent }).moves.find(m => m.lan === lan);
      if (!move) throw new Error('This move is not in the opening book.');
      const { node } = this.rules.call({ cmd: 'play', node: parent, lan });
      this.path.push({ ...move, node });
    }
    this.node = this.path.at(-1).node;
    this.view = this.rules.call({ cmd: 'view', node: this.node }).view;
    const book = this.rules.call({ cmd: 'book', node: this.node });
    this.opening = book.opening;
    this.children = book.moves.map(move => {
      const { node } = this.rules.call({ cmd: 'play', node: this.node, lan: move.lan });
      const next = this.rules.call({ cmd: 'book', node });
      return { ...move, node, opening: next.opening, count: next.moves.length,
        view: this.rules.call({ cmd: 'view', node }).view };
    });
    return this;
  }
}

export function openingUrl(variant, moves = []) {
  const params = new URLSearchParams({ variant });
  if (moves.length) params.set('moves', JSON.stringify(moves));
  return '#/openings?' + params;
}

/** Probe positions directly, without replacing the explorer's selected game. */
export function bookVariants(rules, variants) {
  return variants.filter(v => rules.call({ cmd: 'book', position: v.position }).moves.length > 0);
}
