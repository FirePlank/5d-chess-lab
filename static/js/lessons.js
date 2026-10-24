// The tutorial's lessons (tutorial.js runs them; tests/tutorial.mjs plays every step through the
// rules core). A lesson is a list of steps; a step is one short message and one thing to do:
//   read     Continue when ready.
//   choose   pick an answer (`options`, `answer`); a `predict` question has no wrong answer.
//   click    click a board or square (`targets`; `all`: every one of them).
//   play     an action on the board: `solution` (moves in 5DUCI notation, space separated) is
//            the expected one, and the only one accepted unless a `goal` judges the action
//            instead. `why` explains particular wrong moves, `wrong` any other. The learner
//            submits the action, as in a game. `reply` is the opponent's answer, played after it.
// A step with `at` [position, line] starts there; any other continues from the step before.
// `then` is an opponent action played as the step opens. `mark` points at things on the board:
// boards '(0T2w)', squares '(0T2w)a3', arrows '(0T3)a3>(0T2)a3' (the side to move's move),
// threats (red arrows, the other side's), and voids: places with no board. Text: **bold**.
// tests/tutorial.mjs holds every step to: no check and every timeline active as it opens,
// unless the step says `check` or `inactive`.

/** A 5×5 position from its boards ('fen:l:t:c'). */
const small = (...boards) => `size 5x5 fen ${boards.map((b) => `[${b}]`).join(' ')}`;

// The opening position of the time lessons: a rook and king each.
const ROOKS = small('1r2k/5/5/5/R3K:0:1:w');
// Lesson 2's game up to the travel: White's rook went a1-a3 on turn 2 (so a3 is empty on that
// board), Black's rook b5-c5-c4.
const TRAVEL = '(0T1)e1d1 submit (0T1)b5c5 submit (0T2)a1a3 submit (0T2)c5c4 submit';
// ... and on: White's rook travels back to turn 2 (timeline L1); Black answers on L1 and sends
// its own rook back (timeline L-1).
const BRANCHED = `${TRAVEL} (0T3)a3(0T2)a3 submit (1T2)e5d5 (0T3)c4(0T2)c4 submit`;
// White leads by one timeline (Black has made none).
const LEAD = `${TRAVEL} (0T3)a3(0T2)a3 submit (1T2)e5d5 submit`;

// Single-timeline histories (turns 1-3, White to move on turn 3) and small multiverses for the
// piece lessons: a white piece, black knights to capture, kings out of the way.
const RB_PAST = small('4k/5/n4/5/R3K:0:1:w', '4k/5/n4/5/R2K1:0:1:b', '4k/2n2/5/5/R2K1:0:2:w', '4k/2n2/R4/5/3K1:0:2:b', '3k1/2n2/R4/5/3K1:0:3:w');
const RB_FIND = small('4k/5/n4/5/K4:0:1:w', '4k/5/n4/5/1K3:0:1:b', '4k/5/5/2n2/1K3:0:2:w', '4k/5/R4/2n2/1K3:0:2:b', '4k/5/R4/2n2/1K3:0:3:w');
// Three timelines on turn 3: L1 already ahead (turn 4), so L0 and L2 are the present (and
// L-1, ahead too, keeps L2 active).
const tl3 = (l0, l1, l2) => small('3k1/5/5/1K3/5:-1:4:w', `${l0}:0:3:w`, `${l1}:1:3:w`, `${l1}:1:3:b`, '3k1/5/5/1K3/5:1:4:w', `${l2}:2:3:w`);
const ROOK_L = tl3('4k/5/5/5/K1R2', '4k/5/5/1K3/5', '4k/5/5/5/K1n2');
const ROOK_BLOCKED = tl3('4k/5/5/5/K1R2', '4k/5/5/1K3/2B2', '4k/5/5/5/K1n2');
const Q_LINE = tl3('4k/5/5/5/K1Q2', '4k/5/5/1K3/5', '4k/5/5/5/K1n2');
const B_RL = tl3('4k/5/5/5/K1B2', '4k/5/5/1K3/5', '4k/5/2n2/5/K4');
const B_ONE = small('3k1/5/2B2/5/K4:0:1:w', '3k1/5/2B2/5/1K3:0:1:b', '3k1/5/2Bn1/5/1K3:0:2:w', '3k1/5/2Bn1/5/K4:0:2:b', '3k1/5/2B2/5/K3n:0:3:w');
const B_TWO = small('3k1/5/2B1n/5/K4:0:1:w', '3k1/5/2B1n/5/1K3:0:1:b', '3k1/2n2/2B2/5/1K3:0:2:w', '3k1/2n2/2B2/5/K4:0:2:b', '3k1/2n2/2B2/5/K4:0:3:w');
// A second timeline whose turn-2 board holds the target, its newest board Black's (turn 3).
const withL1 = (piece, sq, l1) => small(`3k1/5/${sq}/5/K4:0:1:w`, `3k1/5/${sq}/5/1K3:0:1:b`, `3k1/5/${sq}/5/1K3:0:2:w`, `3k1/5/${sq}/5/K4:0:2:b`, `3k1/5/${sq}/5/K4:0:3:w`,
  `4k/5/${l1}/5/K4:1:2:w`, `4k/5/${l1}/5/1K3:1:2:b`, '4k/5/5/5/1K3:1:3:w', '3k1/5/5/5/1K3:1:3:b').replaceAll('@', piece);
const B_TL = withL1('B', '2@2', '2n2');
const q3 = (p) => small(`4k/5/5/2${p}2/K4:0:1:w`, `4k/5/5/2${p}2/1K3:0:1:b`, `4k/5/3n1/2${p}2/1K3:0:2:w`, `4k/5/3n1/2${p}2/K4:0:2:b`, `4k/5/5/2${p}2/K3n:0:3:w`);
const q4 = (p) => small(`4k/5/5/2${p}2/K4:0:1:w`, `4k/5/5/2${p}2/1K3:0:1:b`, `4k/5/5/2${p}2/1K3:0:2:w`, `4k/5/5/2${p}2/K4:0:2:b`, `4k/5/5/2${p}2/K4:0:3:w`,
  '4k/5/3n1/5/K4:1:2:w', '4k/5/3n1/5/1K3:1:2:b', '4k/5/5/5/1K3:1:3:w', '3k1/5/5/5/1K3:1:3:b');
const Q_THREE = q3('Q');
const Q_FOUR = q4('Q');
const K_GUARD = small('4k/5/5/5/2K2:0:1:w', '4k/5/5/5/3r1:1:1:w', '4k/5/5/5/3r1:1:1:b');
const N_PAST = small('k4/5/5/1Nn2/3K1:0:1:w', 'k4/5/5/1Nn2/2K2:0:1:b', 'k4/5/5/1N1n1/2K2:0:2:w', 'k4/5/5/1N1n1/3K1:0:2:b', 'k4/5/5/1N3/3K1:0:3:w');
const N_TL = small('k4/5/5/1N3/3K1:0:1:w', 'k4/5/5/1N3/2K2:0:1:b', 'k4/5/5/1N3/2K2:0:2:w', 'k4/5/5/1N3/3K1:0:2:b', 'k4/5/5/1N3/3K1:0:3:w',
  'k4/5/5/1n3/4K:1:1:w', 'k4/5/5/1n3/4K:1:1:b', 'k4/5/5/5/4K:1:2:w', 'k4/5/5/5/4K:1:2:b', 'k4/5/5/5/4K:1:3:w', '1k3/5/5/5/4K:1:3:b');
const N_VOID = small('4k/5/5/5/1NK2:0:1:w', '4k/5/5/5/1N1K1:0:1:b', '3k1/5/5/5/1N1K1:0:2:w', '3k1/5/5/5/1NK2:0:2:b', '4k/5/5/5/1NK2:0:3:w',
  '4k/5/5/5/2K2:-1:4:w', '4k/5/5/5/2K2:1:4:w', '4k/5/5/5/n2K1:2:2:w', '4k/5/5/5/n2K1:2:2:b', '4k/5/5/5/n2K1:2:3:w');
const P_CAPTURE = small('4k/5/2P2/5/K4:0:1:w', '4k/5/2P2/5/1K3:0:1:b', '4k/5/2P2/5/1K3:0:2:w', '4k/5/2P2/5/K4:0:2:b', '4k/5/2P2/5/K4:0:3:w',
  '4k/5/2n2/5/K4:-1:2:w', '4k/5/2n2/5/1K3:-1:2:b', '4k/5/5/5/1K3:-1:3:w', '3k1/5/5/5/1K3:-1:3:b');
// A black rook on L1 attacks the white king on L0 across timelines.
const CHECK = small('4k/5/2N2/5/2K2:0:1:w', '3k1/5/5/5/B1r2:1:1:w');
// White's king left e1 on turn 2; Black's rook has reached e1 since and can slide back to turn 1.
const TIME_CHECK = '(0T1)a1a2 submit (0T1)a4e4 submit (0T2)e1d2 submit (0T2)e4e1 submit';
// The 5D game's "Tricky Checkmates 3" (two even timelines, +0 and -0): mate by making Black
// play both, where its only piece on +0 is a pawn.
const TRICKY = 'size 5x5 even fen [5/p*4/5/5/P*P*3:+0:1:w] [4k*/5/5/K4/1B3:-0:1:w]';
const FAIRY_PRINCESS = B_ONE.replace(/B/g, 'S');
const FAIRY_UNICORN = q3('U');
const FAIRY_DRAGON = q4('D');
const FAIRY_ROYAL = small('1k3/5/2Y2/5/2r2:0:1:w');
const FAIRY_COMMON = small('4k/5/2C2/K4/2r2:0:1:w');
const FAIRY_BRAWN = small('4k/5/3n1/5/K4:-1:1:w', '4k/5/2W2/5/K4:0:1:w');

/** Goals: each judges a submitted action ({moves, before, after}): true, or why not. */
export const goals = {
  /** Any complete action. */
  any: () => true,
  /** One of the moves ends on square `sq` ('(1T3w)c1' or '(1T3)c1'). */
  to: (sq, why) => ({ moves }) => moves.some((m) => sameSquare(m.to, sq)) || why || 'Not quite: look again at the marked target.',
  /** The action includes move `lan`. */
  has: (lan, why) => ({ moves }) => moves.some((m) => moveLan(m) === lan) || why,
  /** Checkmate. */
  mate: (why) => ({ after }) => after.status === 'checkmate' || (after.status === 'stalemate'
    ? 'Stalemate! Black has no move, but isn’t in check: that’s only a draw.' : why || 'Not mate: Black still has a way out.'),
};

/** The sections of the lesson list (after lichess.org/learn's), in order. */
export const CATEGORIES = [
  { key: 'multiverse', name: 'The multiverse', blurb: 'How boards, time and timelines work: the rules of the board itself.' },
  { key: 'pieces', name: 'The pieces', blurb: 'How each piece moves through the four dimensions.' },
  { key: 'fundamentals', name: 'Fundamentals', blurb: 'Check, checkmate and stalemate across time.' },
  { key: 'advanced', name: 'Advanced', blurb: 'The fairy pieces of the 5D game’s variants.' },
];

export const LESSONS = [
  {
    id: 'boards', title: 'Boards in time', blurb: 'Every move makes a new board.',
    recap: [
      'Every move makes a new board. The old one stays, as history.',
      'Time (T) runs left to right. Each turn has a White board, then a Black board.',
      'You move on the newest board, then press Submit.',
    ],
    steps: [
      {
        type: 'play', at: [small('4k/5/5/5/R3K:0:1:w')],
        say: 'It starts as ordinary chess. Move your rook up to **a4**.',
        mark: { arrows: ['(0T1)a1>(0T1)a4'] },
        solution: '(0T1)a1a4',
        wrong: 'Select the rook on a1, then click a4.',
        ok: 'Your move didn’t change the board. It made a **new board** to the right. Black’s reply made another.',
        reply: '(0T1)e5d5',
      },
      {
        type: 'click', say: 'Click the board just after your rook move.',
        targets: ['(0T1b)'],
        wrong: 'Look for the first board where your rook stands on a4.',
        ok: 'Its **dark frame** means Black was to move on it. Light frames are White’s.',
      },
      {
        type: 'click', say: 'You can only move on the **newest** board. Click it.',
        targets: ['(0T2w)'],
        wrong: 'That board is history: it already happened, and it can’t change.',
        ok: 'A **blue outline** marks the boards you can move on.',
      },
      {
        type: 'play', say: 'Move your king up to **e2**.',
        solution: '(0T2)e1e2', reply: '(0T2)d5c5',
        wrong: 'Your king is on e1, on the newest board. Move it one square up.',
        ok: 'Every turn ends with **Submit**, even a single move: in 5D chess you often play on several boards first.',
      },
      {
        type: 'choose', say: 'Turns are numbered along the top: T1, T2, T3. Could you still move on a turn-1 board?',
        options: ['Yes, any board I like', 'No, turn 1 is history'], answer: 1,
        ok: 'This row of boards is a **timeline**: the game’s history, read left to right.',
      },
    ],
  },
  {
    id: 'travel', title: 'Travelling in time', blurb: 'Move into the past, and a new timeline appears.',
    recap: [
      'Pieces move through time (T) as well as across the board.',
      'Moving into the past never changes it: a new timeline branches off instead.',
      'Your timelines appear below the first one, your opponent’s above. Up and down is the L direction.',
    ],
    steps: [
      {
        type: 'choose', at: [ROOKS, TRAVEL], predict: true,
        say: 'Pieces can travel back in time! If your rook jumps back one turn, what happens to that old board?',
        mark: { arrows: ['(0T3)a3>(0T2)a3'] },
        options: ['It changes: the rook appears on it', 'It stays as it was; a copy branches off', 'Nothing: you can’t do that'], answer: 1,
        ok: 'Let’s find out.',
      },
      {
        type: 'play', say: 'Time is just one more direction, called **T**. Move your rook one turn back, to the marked square.',
        mark: { arrows: ['(0T3)a3>(0T2)a3'], squares: ['(0T2w)a3'] },
        solution: '(0T3)a3(0T2)a3',
        why: { '(0T3)a3(0T1)a3': 'That’s two turns back. Go back just one turn, to turn 2.' },
        wrong: 'Select the rook, then click the dot on the turn-2 board.',
        ok: 'The past stayed as it was. Instead a **new timeline** branched off below, where your rook arrived from the future.',
      },
      {
        type: 'click', say: 'Your rook met its younger self! Click the board with two white rooks.',
        targets: ['(1T2b)'],
        wrong: 'Look in the new row, below the first one.',
        ok: 'That’s the new timeline, **L1**. The first one is L0. The old L0 board still has one rook.',
      },
      {
        type: 'read', say: 'Up and down, between timelines, is the fourth direction: **L**. Timelines you make appear **below**; your opponent’s appear **above**.',
        mark: { boards: ['(1T2b)'] },
      },
      {
        type: 'click', then: '(1T2)e5d5 (0T3)c4(0T2)c4',
        say: 'Black travelled back too, with its rook. Click a board of the timeline Black just made.',
        targets: ['(-1T3w)'],
        wrong: 'Black’s new timeline is above the first one.',
        ok: 'Black’s timeline, **L−1**, is above. Black’s rook met its younger self, too.',
      },
      {
        type: 'choose', say: 'Quick check: why did the new timelines appear?',
        options: ['A piece moved onto a board in the past', 'Someone captured a piece', 'Every turn makes one'], answer: 0,
        ok: 'Travel into the past branches a new timeline. The old one carries on as before.',
      },
    ],
  },
  {
    id: 'present', title: 'The present', blurb: 'Which boards you must play, and which you may.',
    recap: [
      'The present is the earliest turn where a timeline is waiting for a move.',
      'You must play every board in the present (solid outline). Boards ahead are optional (dashed).',
      'A move into the past drags the present back: your opponent must answer there first.',
    ],
    steps: [
      {
        type: 'read', at: [ROOKS, BRANCHED],
        say: 'The shaded column is **the present**: the earliest turn where a timeline is waiting. Here it is turn 3.',
        mark: { boards: ['(1T3w)', '(-1T3w)'] },
      },
      {
        type: 'click', all: true,
        say: 'You must move on **every** board in the present. Click both of yours.',
        targets: ['(1T3w)', '(-1T3w)'],
        why: { '(0T4w)': 'That board is **ahead** of the present: optional, so its outline is dashed.' },
        wrong: 'That one is history. Look in the shaded column.',
        ok: 'Both found. Boards ahead of the present, like the one on L0, are optional.',
      },
      {
        type: 'play', goal: goals.any,
        say: 'Play one move on each of those two boards, then press **Submit**.',
        solution: '(1T3)a1b1 (-1T3)d1e1',
        wrong: 'Play on the boards in the shaded column.',
        ok: 'That’s one full turn: a move on every board in the present.',
      },
      {
        type: 'choose', at: [ROOKS, `${TRAVEL} (0T3)a3b3 submit (0T3)c4c5 submit`], predict: true,
        say: 'One timeline, turn 4. If your rook travels back to turn 2, where will the present be?',
        mark: { arrows: ['(0T4)b3>(0T2)b3'] },
        options: ['Still at turn 4', 'Back at turn 2'], answer: 1,
        ok: 'Try it and watch the shaded column.',
      },
      {
        type: 'play', say: 'Move your rook two turns back in time.',
        solution: '(0T4)b3(0T2)b3',
        why: { '(0T4)b3(0T3)b3': 'That’s one turn back. Go back two, to turn 2.', '(0T4)b3(0T1)b3': 'That’s three turns back. Go back two, to turn 2.' },
        wrong: 'Select the rook and pick the dot on the turn-2 board.',
        ok: 'The present jumped back to turn 2: Black must answer there first. This is called **stalling**.',
      },
    ],
  },
  {
    id: 'between', title: 'Between timelines', blurb: 'Jump to other timelines, and meet the void.',
    recap: [
      'Pieces move up and down to other timelines: the L direction.',
      'Landing on the newest board of a timeline makes no new timeline, and plays both boards at once.',
      'Landing on an older board makes a new timeline.',
      'Where there is no board (the void), pieces can’t land or pass.',
    ],
    steps: [
      {
        type: 'play', at: [ROOKS, BRANCHED],
        say: 'Jump your rook from L1 up to a1 on **L−1**, two timelines up.',
        mark: { arrows: ['(1T3)a1>(-1T3)a1'] },
        solution: '(1T3)a1(-1T3)a1',
        why: { '(1T3)a1(0T3)a1': 'That stops on L0. Go one timeline further, to L−1.' },
        wrong: 'Select the rook on a1 of L1 and pick the dot on L−1.',
        ok: 'No new timeline: that board was the newest of its row. And one move played **both** boards!',
      },
      {
        type: 'choose', at: [ROOKS, BRANCHED], predict: true,
        say: 'What if the rook stops on L0 instead? Its turn-3 board is history now.',
        mark: { arrows: ['(1T3)a1>(0T3)a1'] },
        options: ['It just arrives there', 'A new timeline branches off'], answer: 1,
        ok: 'Try it.',
      },
      {
        type: 'play',
        goal: goals.has('(1T3)a1(0T3)a1', 'Jump the rook from L1 to a1 on L0.'),
        say: 'Jump the rook to L0, play any move on L−1, then press Submit.',
        mark: { arrows: ['(1T3)a1>(0T3)a1'] },
        solution: '(1T3)a1(0T3)a1 (-1T3)d1e1',
        ok: 'A new timeline, **L2**, branched from that old board. Any jump into the past does this.',
      },
      {
        type: 'choose', at: [ROOKS, BRANCHED],
        say: 'L1 began on turn 2: before that it has **no boards**. Can the rook on L1 go back to turn 1?',
        mark: { voids: ['(1T1w)', '(1T2w)'], squares: ['(1T3w)a3'] },
        options: ['Yes, back one turn', 'No: there is nothing there'], answer: 1,
        ok: 'Where there is no board is called **the void**. Pieces can’t land in it.',
      },
      {
        type: 'choose',
        at: [small('4k/5/5/5/R3K:0:1:w', '4k/5/5/5/R2K1:0:1:b', '3k1/5/5/5/R2K1:0:2:w', '3k1/5/5/5/R1K2:0:2:b', '4k/5/5/5/R1K2:0:3:w',
          '4k/5/5/5/2K2:-1:4:w', '4k/5/5/5/2K2:1:4:w', '4k/5/5/5/n1K2:2:2:w', '4k/5/5/5/n2K1:2:2:b', '4k/5/5/5/n2K1:2:3:w')],
        say: 'Can your rook on L0 capture the knight on **L2**, two timelines down?',
        mark: { voids: ['(1T3w)'], arrows: ['(0T3)a1>(2T3)a1'] },
        options: ['Yes, straight down', 'No: L1 has no board on its way'], answer: 1,
        ok: 'The void blocks a path like the edge of the board. (Only knights jump over it.)',
      },
    ],
  },
  {
    id: 'active', title: 'Active timelines', blurb: 'Why you can’t branch forever.',
    recap: [
      'Each side may lead by one timeline at most.',
      'Extra timelines are inactive: faded, they don’t hold the present back, and nobody has to play them.',
      'The game simply moves on without them; once the other side catches up, they become active again.',
    ],
    steps: [
      {
        type: 'read', at: [ROOKS, LEAD],
        say: 'You have made one timeline (L1); Black has made none. Each side may **lead by one** timeline at most.',
        mark: { boards: ['(1T3w)'] },
      },
      {
        type: 'choose', predict: true,
        say: 'You already lead by one. What happens to a second new timeline?',
        options: ['It works just like the first', 'It is **inactive**: it doesn’t count yet'], answer: 1,
        ok: 'Let’s make one and see.',
      },
      {
        type: 'play', say: 'Jump the rook from L1 to a1 on L0’s older board, making a second timeline.',
        mark: { arrows: ['(1T3)a1>(0T3)a1'] },
        solution: '(1T3)a1(0T3)a1',
        wrong: 'Select the rook on a1 of L1 and pick the dot on L0.',
        ok: 'L2 is faded: **inactive**. It doesn’t count for the present, and nobody has to play on it.',
      },
      {
        type: 'read', inactive: true, then: '(0T3)c4c5 (1T3)d5e5',
        say: 'Black played only its two active boards and left L2 alone. The present moved on to turn 4 anyway.',
        mark: { boards: ['(0T4w)', '(1T4w)'] },
      },
      {
        type: 'click', all: true, inactive: true,
        say: 'Click every board you must play now.',
        targets: ['(0T4w)', '(1T4w)'],
        why: {
          '(2T3b)': 'L2 is inactive: nobody has to play it, so it doesn’t hold the present back.',
        },
        wrong: 'That one is history. Look in the shaded column.',
        ok: 'Just the two active boards. L2 waits, frozen, as long as it stays inactive.',
      },
      {
        type: 'read', at: [ROOKS, `${LEAD} (1T3)a1(0T3)a1 submit (0T3)c4c5 (1T3)d5e5 submit (0T4)d1e1 (1T4)d1e1 submit`],
        then: '(0T4)c5(0T3)c5 (1T4)e5d5 (2T3)e5d5',
        say: 'Now Black makes a timeline of its own (L−1). You lead by one again, so L2 is **active** and back in the present.',
        mark: { boards: ['(2T4w)', '(-1T4w)'] },
      },
      {
        type: 'choose', say: 'Why do you think this rule exists?',
        options: ['Without it, you could dodge any attack by branching into the past forever', 'To keep the screen tidy'], answer: 0,
        ok: 'Each new timeline can drag the present back. Without a limit, a player could stall forever.',
      },
    ],
  },

  // ------------------------------------------------------------------ the pieces
  {
    id: 'rook', title: 'The rook', blurb: 'One dimension, any distance.', piece: 'rook', category: 'pieces',
    recap: [
      'Every square has four coordinates, the four dimensions: file, rank, turn (T) and timeline (L).',
      'A rook moves along exactly one dimension, as far as it likes.',
      'Pieces on its path block it, on the board, through time and across timelines.',
    ],
    steps: [
      {
        type: 'play', at: [RB_PAST],
        say: 'Four dimensions: file, rank, **turn** and **timeline**. A rook moves along one of them. Capture the knight two turns back.',
        mark: { arrows: ['(0T3)a3>(0T1)a3'] },
        solution: '(0T3)a3(0T1)a3',
        why: { '(0T3)a3(0T2)a3': 'One turn back, a3 is empty. Keep going: two turns back.' },
        wrong: 'The knight is on a3, two turns ago. Only the turn changes.',
        ok: 'Along the turn dimension. The capture in the past branched a new timeline, as always.',
      },
      {
        type: 'play', at: [ROOK_L],
        say: 'Along the timeline dimension now: capture the knight on **L2**, two timelines down.',
        solution: '(0T3)c1(2T3)c1',
        wrong: 'The knight is on c1 of L2: same square, same turn, two timelines down.',
        ok: 'Straight past L1, two timelines down. It played both boards, and L1 (ahead of the present) can wait.',
      },
      {
        type: 'choose', at: [ROOK_BLOCKED],
        say: 'Your bishop now stands on c1 of L1. Can the rook still reach the knight on L2?',
        mark: { squares: ['(1T3w)c1'], arrows: ['(0T3)c1>(2T3)c1'] },
        options: ['Yes, it jumps over', 'No: the bishop blocks the way'], answer: 1,
        ok: 'Pieces block a rook in every dimension, not only on the board.',
      },
      {
        type: 'play', at: [RB_FIND], goal: goals.to('(0T1)a3', 'That doesn’t capture. Find the knight that differs from your rook in one dimension only.'),
        say: 'Only one knight is within your rook’s reach. Capture it.',
        solution: '(0T3)a3(0T1)a3',
        ok: 'That knight differed from your rook in one dimension only: the turn.',
      },
      {
        type: 'choose', say: 'Which of these is a rook move?',
        options: ['Same square, three turns back', 'One file right and one turn back', 'One timeline down and two squares up'], answer: 0,
        ok: 'One dimension at a time. The other two change two dimensions: not rook moves.',
      },
    ],
  },
  {
    id: 'bishop', title: 'The bishop', blurb: 'Two dimensions, the same distance in each.', piece: 'bishop', category: 'pieces',
    recap: [
      'A bishop moves along exactly two dimensions at once, the same distance in each.',
      'Any two: file and rank (as in chess), file and turn, turn and timeline, rank and timeline...',
      'It can go as far as it likes, as long as nothing blocks it.',
    ],
    steps: [
      {
        type: 'play', at: [B_ONE],
        say: 'A **bishop** moves along two dimensions at once, the same distance in each. Capture: one file right, one turn back.',
        mark: { arrows: ['(0T3)c3>(0T2)d3'] },
        solution: '(0T3)c3(0T2)d3',
        wrong: 'The knight is one file to the right, one turn back.',
        ok: 'File and turn, one step each.',
      },
      {
        type: 'play', at: [B_TWO],
        say: 'Bishops go further, too. Capture the knight two files right and **two** turns back.',
        solution: '(0T3)c3(0T1)e3',
        wrong: 'Two files right, two turns back: the knight on e3 on turn 1.',
        ok: 'Two and two: the same distance in both dimensions.',
      },
      {
        type: 'play', at: [B_TL],
        say: 'Same square, one turn back and one timeline down: two dimensions as well. Capture the knight.',
        solution: '(0T3)c3(1T2)c3',
        wrong: 'The knight is on c3 of L1, one turn back.',
        ok: 'Turn and timeline together. The capture branched a timeline, L2: faded, since you were already one ahead.',
      },
      {
        type: 'play', at: [B_RL],
        say: 'Now rank and timeline: capture the knight two timelines down, two squares up.',
        solution: '(0T3)c1(2T3)c3',
        wrong: 'The knight is on c3 of L2: two timelines down, two ranks up.',
        ok: 'Rank and timeline, two each.',
      },
      {
        type: 'choose', at: [B_TWO], say: 'A bishop goes two turns back. How far must it move in one other dimension?',
        options: ['One step', 'Exactly two steps', 'Any distance'], answer: 1,
        ok: 'Always the same distance in both of its dimensions.',
      },
    ],
  },
  {
    id: 'queen', title: 'The queen', blurb: 'Any number of dimensions at once.', piece: 'queen', category: 'pieces',
    recap: [
      'A queen moves along any number of dimensions at once (one, two, three or all four), the same distance in each.',
      'One dimension like a rook, two like a bishop, and three or four, which no other standard piece can.',
    ],
    steps: [
      {
        type: 'play', at: [Q_LINE],
        say: 'A **queen** moves along any number of dimensions, the same distance in each. One dimension, like a rook: capture on L2.',
        solution: '(0T3)c1(2T3)c1',
        wrong: 'Same square and turn, two timelines down.',
        ok: 'One dimension. Two (like a bishop) works too.',
      },
      {
        type: 'play', at: [Q_THREE],
        say: 'Three dimensions: capture the knight one rank up, one file right and one turn back.',
        mark: { arrows: ['(0T3)c2>(0T2)d3'] },
        solution: '(0T3)c2(0T2)d3',
        wrong: 'One up, one right, one turn back: the knight on d3 of turn 2.',
        ok: 'Three dimensions in one move.',
      },
      {
        type: 'play', at: [Q_FOUR],
        say: 'All **four**: capture the knight one up, one right, one turn back and one timeline down.',
        solution: '(0T3)c2(1T2)d3',
        wrong: 'The knight is on d3 of L1, one turn back.',
        ok: 'Every dimension at once. That’s why queens are so dangerous in 5D.',
      },
      {
        type: 'choose', at: [Q_THREE], say: 'Which of these is **not** a queen move?',
        options: ['Same square, two turns back', 'One step in all four dimensions', 'Two files right and one turn back'], answer: 2,
        ok: 'Two and one aren’t the same distance: that’s a knight move.',
      },
    ],
  },
  {
    id: 'king', title: 'The king', blurb: 'One step, in any dimensions.', piece: 'king', category: 'pieces',
    recap: [
      'A king steps once, along any number of dimensions at once.',
      'It never steps into check, wherever the attack comes from.',
      'Castling happens on one board only, as in chess.',
    ],
    steps: [
      {
        type: 'play', at: [small('4k/5/5/5/1K3:0:1:w', '4k/5/5/2n2/5:1:1:w')],
        say: 'A **king** steps once, in any dimensions at once. Capture the knight: one timeline down, one square up and right.',
        mark: { arrows: ['(0T1)b1>(1T1)c2'] },
        solution: '(0T1)b1(1T1)c2',
        wrong: 'Step to c2 on L1: timeline, file and rank, one step each.',
        ok: 'One step in three dimensions, and it played both boards.',
      },
      {
        type: 'choose', at: [K_GUARD],
        say: 'The black rook on L1 guards d1 across timelines. Can your king step to d1?',
        mark: { threats: ['(1T1w)d1>(0T1w)d1'] },
        options: ['Yes', 'No'], answer: 1,
        ok: 'A king never steps into check, whichever board the attack comes from.',
      },
      {
        type: 'play', say: 'Step your king to a safe square.',
        goal: goals.any, solution: '(0T1)c1b2',
        ok: 'Safe. Kings also castle only on one board, as in chess.',
      },
    ],
  },
  {
    id: 'knight', title: 'The knight', blurb: 'Two along one dimension, one along another.', piece: 'knight', category: 'pieces',
    recap: [
      'A knight moves two steps along one dimension and one step along another: any two of the four.',
      'It jumps: pieces in between don’t block it, and neither does the void.',
    ],
    steps: [
      {
        type: 'play', at: [N_PAST],
        say: 'A **knight** moves two steps along one dimension and one along another. Capture: two files right, one turn back.',
        mark: { arrows: ['(0T3)b2>(0T2)d2'] },
        solution: '(0T3)b2(0T2)d2',
        why: { '(0T3)b2(0T1)c2': 'That works too, but find the one two files right and one turn back.' },
        wrong: 'The knight on d2, one turn back, is two files right of yours.',
        ok: 'Two steps in file, one in time.',
      },
      {
        type: 'play', at: [N_PAST],
        say: 'Now the other knight: one file right, **two** turns back.',
        solution: '(0T3)b2(0T1)c2',
        why: { '(0T3)b2(0T2)d2': 'That one is two files right, one turn back. Find the other.' },
        wrong: 'The knight on c2 two turns back: one file right, two turns back.',
        ok: 'One step in file, two in time.',
      },
      {
        type: 'play', at: [N_TL],
        say: 'Time and timeline: capture on the same square, two turns back and one timeline down.',
        solution: '(0T3)b2(1T1)b2',
        wrong: 'The knight is on b2 of L1, two turns back.',
        ok: 'The board looks the same, but two dimensions changed.',
      },
      {
        type: 'play', at: [N_VOID],
        say: 'L1 has no board on turn 3: the void. Knights jump right over it. Capture the knight on L2.',
        mark: { voids: ['(1T3w)'] },
        solution: '(0T3)b1(2T3)a1',
        wrong: 'Two timelines down, one file left.',
        ok: 'Over the void! A rook could never pass there.',
      },
    ],
  },
  {
    id: 'pawn', title: 'The pawn', blurb: 'Forward up the board, and up the timelines.', piece: 'pawn', category: 'pieces',
    recap: [
      'A pawn moves forward: up the board, or one timeline toward the opponent’s (two on its first move, as on the board).',
      'It captures diagonally: on the board (file and rank), or through time (one timeline forward and one turn back or ahead). Never a mix, like rank and turn.',
      'It never moves straight through time, and promotes on the last rank. En passant works on a single board only.',
    ],
    steps: [
      {
        type: 'play', at: [small('4k/5/5/2P*2/K4:0:1:w')],
        say: 'On the board, pawns move as in chess: two squares on their first move. Push this one to **c4**.',
        solution: '(0T1)c2c4',
        why: { '(0T1)c2c3': 'One square works, but try the double step.' },
        wrong: 'Push the pawn two squares up.',
        ok: 'As in chess.',
      },
      {
        type: 'choose', at: [small('4k/5/5/5/K4:-1:1:w', '4k/5/2P2/5/K4:0:1:w')], predict: true,
        say: 'Your opponent’s timelines are above, so for a white pawn, which way is forward across timelines?',
        options: ['Up, toward Black’s timelines', 'Down, toward White’s'], answer: 0,
        ok: 'Up: the same way it walks up its own board.',
      },
      {
        type: 'play', say: 'Move your pawn **forward one timeline**: to c3 on L−1, the same square.',
        mark: { arrows: ['(0T1)c3>(-1T1)c3'] },
        solution: '(0T1)c3(-1T1)c3',
        why: { '(0T1)c3c4': 'That’s forward on the board. Go up one timeline instead.' },
        wrong: 'Select the pawn and pick the dot on L−1.',
        ok: 'Forward through timelines. And again, one move played both boards.',
      },
      {
        type: 'play', at: [P_CAPTURE],
        say: 'Pawns capture **diagonally**: on the board (file and rank), or through time (timeline and turn). Capture the knight.',
        mark: { arrows: ['(0T3)c3>(-1T2)c3'] },
        solution: '(0T3)c3(-1T2)c3',
        wrong: 'The knight is one timeline up and one turn back.',
        ok: 'A diagonal capture through time and timeline.',
      },
      {
        type: 'choose', at: [P_CAPTURE], say: 'Could a pawn capture one rank up and one turn back?',
        options: ['Yes', 'No'], answer: 1,
        ok: 'Only file and rank, or timeline and turn: never a mix of the two pairs.',
      },
      {
        type: 'play', at: [small('5/1P3/4k/5/K4:0:1:w')],
        say: 'Pawns still promote on the last rank. Push this one to **b5**.',
        solution: '(0T1)b4b5',
        wrong: 'Push the pawn one square up.',
        ok: 'A new queen.',
      },
      {
        type: 'choose', say: 'Can a pawn move straight back in time, like a rook?',
        options: ['Yes', 'No, only forward'], answer: 1,
        ok: 'Pawns only go forward: up the board or up the timelines (diagonally, to capture).',
      },
    ],
  },

  // ------------------------------------------------------------------ fundamentals
  {
    id: 'check', title: 'Check across time', blurb: 'Threats come from any board.', category: 'fundamentals',
    recap: [
      'A king is in check when an enemy piece could capture it next turn, from any board.',
      'Escape as in chess: capture the attacker, move the king, or block (a piece in between, even on a board in between).',
      'You can’t end your turn with any king in check.',
    ],
    steps: [
      {
        type: 'read', at: [CHECK], check: true,
        say: '**Check!** The black rook on L1 could capture your king on L0, straight across timelines.',
        mark: { threats: ['(1T1w)c1>(0T1w)c1'] },
      },
      {
        type: 'play', check: true, say: 'Get out of check: capture the rook with your knight.',
        solution: '(0T1)c3(1T1)c1',
        wrong: 'Your knight can reach the rook: one timeline down, two squares down.',
        ok: 'Attacker gone. The jump also played both boards.',
      },
      {
        type: 'play', at: [CHECK], check: true,
        goal: ({ moves }) => moves.some((m) => moveLan(m).startsWith('(0T1)c1')) || 'Escape by moving the king this time.',
        say: 'Same check. This time step your **king** out of the rook’s line, play any move on L1, and Submit.',
        solution: '(0T1)c1d2 (1T1)a1b2',
        ok: 'Safe. A king can also escape by capturing across timelines.',
      },
      {
        type: 'choose', at: [CHECK], check: true,
        say: 'Could you ignore the check and just move other pieces?',
        options: ['Yes', 'No'], answer: 1,
        ok: 'Submit stays disabled while any king of yours could be captured.',
      },
    ],
  },
  {
    id: 'timecheck', title: 'Checks through time', blurb: 'Your king’s past self can be attacked too.', category: 'fundamentals',
    recap: [
      'A king on an older board can be captured too: a piece travelling back in time gives a check.',
      'That king is in the past: it can’t move, and nothing can be put on a past board to block.',
      'So checks through time are strong: usually only capturing the attacker helps.',
    ],
    steps: [
      {
        type: 'read', at: [small('4k/r4/5/5/R3K:0:1:w'), TIME_CHECK], check: true,
        say: 'Your king on d2 looks safe. But the rook can slide back in time and capture it **where it stood on turn 1**.',
        mark: { threats: ['(0T3w)e1>(0T1w)e1'] },
      },
      {
        type: 'choose', check: true, predict: true,
        say: 'How can you answer a check on your king’s past self?',
        options: ['Move that king away', 'Block the rook’s path', 'Capture the rook'], answer: 2,
        ok: 'The past is frozen: that king can’t move, and nothing can be put on a past board.',
      },
      {
        type: 'play', check: true, say: 'Capture the rook with your king.',
        solution: '(0T3)d2e1',
        wrong: 'Your king on d2 can take the rook on e1.',
        ok: 'The only legal move. Checks through time leave few answers: that makes them strong.',
      },
    ],
  },
  {
    id: 'mate', title: 'Checkmate', blurb: 'Leave no escape, in space or in time.', category: 'fundamentals',
    recap: [
      'Checkmate: in check, with no legal turn at all. You win.',
      'In 5D, kings can escape through time and across timelines; a mate must stop those too.',
    ],
    steps: [
      {
        type: 'play', at: [small('k4/5/K4/5/4R:0:1:w')], goal: goals.mate(),
        say: 'Checkmate in one move. Careful: one rook move leaves Black stuck but not in check.',
        solution: '(0T1)e1e5',
        ok: 'Checkmate! On a single board with no past, it works just like chess.',
      },
      {
        type: 'play', at: [small('k4/5/5/K4/4R:0:1:w'), '(0T1)a2a3 submit (0T1)a5b5 submit (0T2)e1e2 submit (0T2)b5a5 submit'],
        say: 'Same idea, but this game has a past. Play **Re5** and watch.',
        mark: { arrows: ['(0T3)e2>(0T3)e5'] },
        solution: '(0T3)e2e5', reply: '(0T3)a5(0T2)a5',
        wrong: 'Move the rook up to e5.',
        ok: 'The king **escaped into the past**, where your rook wasn’t on the fifth rank yet. Not mate!',
      },
      {
        type: 'play', at: [small('k4/5/K4/5/5:0:1:w', '3RR/5/K4/5/4n:1:1:w')], goal: goals.mate(),
        say: 'Mate the king on L0 using a rook from L1. Escapes onto L1 must be covered too.',
        solution: '(1T1)e5(0T1)e5',
        ok: 'Checkmate across timelines! One rook mates on L0 while the other guards L1.',
      },
    ],
  },
  {
    id: 'stalemate', title: 'Stalemate or mate?', blurb: 'When no legal turn is a draw, and when it’s a loss.', category: 'fundamentals',
    recap: [
      'No legal turn and not in check: stalemate, a draw.',
      'No legal turn while in check: checkmate. Remember a turn must play every board in the present.',
      'On this site (the tournament rule), a stalemated side whose kings are all on inactive timelines loses.',
    ],
    steps: [
      {
        type: 'choose', at: [TRICKY], predict: true,
        say: 'If Black ends up with no legal turn but is **not** in check, who wins?',
        options: ['White', 'Nobody: it’s a draw (stalemate)'], answer: 1,
        ok: 'Stalemate is a draw. But in 5D, “no legal turn” has a twist: let’s see.',
      },
      {
        type: 'play', goal: goals.mate(), submit: 'self',
        say: 'Mate in one. Black must play **both** timelines, and its only piece on L+0 is a pawn. Use your bishop and a pawn.',
        solution: '(-1T1)b1e4 (0T1)a1a3',
        ok: 'The pawn blocks Black’s only piece on L+0, and Be4 attacks the king’s past self. Black can’t answer both: mate!',
      },
      {
        type: 'choose', at: [TRICKY],
        say: 'A stalemate, but all of Black’s kings are on **inactive** timelines. What is the result on this site?',
        options: ['A draw', 'Black loses: its kings are exiled'], answer: 1,
        ok: 'The community tournament rule: exiled kings lose a stalemate. If both or neither side is exiled, it’s a draw.',
      },
    ],
  },

  // ------------------------------------------------------------------ advanced
  {
    id: 'fairy', title: 'Fairy pieces', blurb: 'Princess, unicorn and dragon.', piece: 'unicorn', category: 'advanced',
    recap: [
      'Princess: moves like a rook or a bishop (one or two dimensions).',
      'Unicorn: exactly three dimensions at once, the same distance in each.',
      'Dragon: exactly four dimensions at once. Neither can move on a single board.',
    ],
    steps: [
      {
        type: 'play', at: [FAIRY_PRINCESS],
        say: 'Some variants add fairy pieces. A **princess** moves like a rook or a bishop. Capture the knight, one file right and one turn back.',
        solution: '(0T3)c3(0T2)d3',
        wrong: 'One file right, one turn back: a bishop-like move.',
        ok: 'Rook or bishop moves: a queen without its three- and four-dimension moves.',
      },
      {
        type: 'play', at: [FAIRY_UNICORN],
        say: 'A **unicorn** moves along exactly three dimensions. Capture: one up, one right, one turn back.',
        solution: '(0T3)c2(0T2)d3',
        wrong: 'One rank up, one file right, one turn back.',
        ok: 'Three dimensions, never fewer.',
      },
      {
        type: 'play', at: [FAIRY_DRAGON],
        say: 'A **dragon** moves along all four dimensions at once. Capture the knight on L1.',
        solution: '(0T3)c2(1T2)d3',
        wrong: 'One up, one right, one turn back, one timeline down.',
        ok: 'All four, every time.',
      },
      {
        type: 'choose', at: [FAIRY_UNICORN], say: 'Can a unicorn or a dragon move on just its own board?',
        options: ['Yes', 'No'], answer: 1,
        ok: 'A move on one board changes only file and rank: two dimensions. Both need more.',
      },
    ],
  },
  {
    id: 'fairy2', title: 'Royals and brawns', blurb: 'Royal queen, common king and brawn.', piece: 'royalqueen', category: 'advanced',
    recap: [
      'Royal queen: moves like a queen, but is royal: it can be checked and mated like a king.',
      'Common king: moves like a king, but is not royal: it can be captured like any piece.',
      'Brawn: a pawn that also captures one step forward plus one step in another dimension.',
    ],
    steps: [
      {
        type: 'play', at: [FAIRY_ROYAL], check: true, goal: goals.any,
        say: 'A **royal queen** moves like a queen but counts as a king. The rook attacks it: get it to safety.',
        solution: '(0T1)c3d4',
        ok: 'Royal pieces must never be left where they can be captured.',
      },
      {
        type: 'choose', at: [FAIRY_COMMON],
        say: 'A **common king** moves like a king but isn’t royal. The rook attacks it. Are you in check?',
        options: ['Yes', 'No'], answer: 1,
        ok: 'Not royal: losing it is like losing any other piece.',
      },
      {
        type: 'play', at: [FAIRY_BRAWN],
        say: 'A **brawn** is a pawn with more captures. Capture the knight: one timeline up and one file right.',
        solution: '(0T1)c3(-1T1)d3',
        wrong: 'One timeline up, one file right.',
        ok: 'A pawn couldn’t: it captures across timelines only with a turn step.',
      },
    ],
  },
];

// ------------------------------------------------------------------ notation

const FILES = 'abcdefgh';

/** A move's 5DUCI text: (0T3)a3(0T2)a3, or (0T1)a1a4 on one board. */
export function moveLan(m) {
  const sq = (p) => FILES[p[2]] + (p[3] + 1);
  const a = `(${m.from[0]}T${m.from[1]})${sq(m.from)}`;
  const same = m.from[0] === m.to[0] && m.from[1] === m.to[1];
  return (same ? a + sq(m.to) : `${a}(${m.to[0]}T${m.to[1]})${sq(m.to)}`) + (m.promote || '');
}

const MOVE = /\((-?\d+)T(\d+)\)([a-h])(\d)(?:\((-?\d+)T(\d+)\))?([a-h])(\d)([QRBNUDSCP]?)/g;

/** The moves of an action in 5DUCI notation (space separated). */
export function parseMoves(text) {
  const out = [];
  for (const m of (text || '').matchAll(MOVE)) {
    const [, l, t, fx, fy, tl, tt, tx, ty, p] = m;
    const mv = { from: [+l, +t, FILES.indexOf(fx), +fy - 1], to: [tl == null ? +l : +tl, tt == null ? +t : +tt, FILES.indexOf(tx), +ty - 1] };
    if (p) mv.promote = p;
    out.push(mv);
  }
  return out;
}

/** A board '(0T2w)' or square '(0T2w)a3' as {l, t, c[, x, y]}; `c` defaults to `player`. */
export function parsePlace(text, player = 0) {
  const m = /^\((-?\d+)T(\d+)([wb]?)\)(?:([a-h])(\d))?$/.exec(text.trim());
  if (!m) throw new Error(`bad place ${text}`);
  const p = { l: +m[1], t: +m[2], c: m[3] ? (m[3] === 'b' ? 1 : 0) : player };
  if (m[4]) { p.x = FILES.indexOf(m[4]); p.y = +m[5] - 1; }
  return p;
}

/** Whether square [l, t, x, y] is the square `text` names (its colour aside). */
function sameSquare(sq, text) {
  const p = parsePlace(text);
  return sq[0] === p.l && sq[1] === p.t && sq[2] === p.x && sq[3] === p.y;
}

/** A step's marks for the board (`overlay.lesson`), `player` being the side to move. */
export function marksOf(mark, player) {
  if (!mark) return null;
  const arrow = (text, c) => {
    const [a, b] = text.split('>').map((s) => parsePlace(s, c));
    return { from: [a.l, a.t, a.x, a.y], to: [b.l, b.t, b.x, b.y], c: a.c };
  };
  return {
    boards: (mark.boards || []).map((s) => parsePlace(s, player)),
    squares: (mark.squares || []).map((s) => parsePlace(s, player)),
    arrows: (mark.arrows || []).map((s) => arrow(s, player)),
    threats: (mark.threats || []).map((s) => arrow(s, 1 - player)),
    voids: (mark.voids || []).map((s) => parsePlace(s, player)),
  };
}

/** Whether a clicked square {l, t, c, x, y} is on `target` (a board, or that square). */
export function onTarget(sq, target) {
  const p = parsePlace(target, sq.c);
  if (p.l !== sq.l || p.t !== sq.t || p.c !== sq.c) return false;
  return p.x == null || (p.x === sq.x && p.y === sq.y);
}
