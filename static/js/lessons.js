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
        type: 'read', say: 'Up and down, between timelines, is the fourth direction: **L**. Timelines you make appear **below**; Black’s appear **above**.',
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
      'Extra timelines are inactive: faded, they don’t count for the present, and nobody has to play them.',
      'When the other side catches up, they become active again.',
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
        type: 'read', then: '(0T3)c4(0T2)c4 (1T3)d5d4 (2T3)e5d5',
        say: 'Black just made a timeline of its own (L−1). You lead by only one again, so L2 is **active** once more.',
        mark: { boards: ['(2T4w)', '(-1T3w)'] },
      },
      {
        type: 'choose', say: 'Why do you think this rule exists?',
        options: ['Without it, you could dodge any attack by branching into the past forever', 'To keep the screen tidy'], answer: 0,
        ok: 'Each new timeline can drag the present back. Without a limit, a player could stall forever.',
      },
    ],
  },
  {
    id: 'rookbishop', title: 'Rook and bishop', blurb: 'Pieces move in four directions: file, rank, turn and timeline.',
    recap: [
      'Every square has four coordinates: file, rank, turn (T) and timeline (L).',
      'A rook changes exactly one of them, by any distance.',
      'A bishop changes exactly two, by the same amount.',
    ],
    steps: [
      {
        type: 'play',
        at: [small('4k/5/n4/5/R3K:0:1:w', '4k/5/n4/5/R2K1:0:1:b', '4k/2n2/5/5/R2K1:0:2:w', '4k/2n2/R4/5/3K1:0:2:b', '3k1/2n2/R4/5/3K1:0:3:w')],
        say: 'A **rook** changes one coordinate, any distance. Capture the knight two turns back, on the same square.',
        mark: { arrows: ['(0T3)a3>(0T1)a3'] },
        solution: '(0T3)a3(0T1)a3',
        why: { '(0T3)a3(0T2)a3': 'One turn back, a3 is empty. Keep going: two turns back.' },
        wrong: 'The knight is on a3 two turns ago. Only the turn changes.',
        ok: 'Captured in the past, and a new timeline branched off, as always.',
      },
      {
        type: 'play', at: [small('4k/5/5/5/1KR2:0:1:w', '4k/5/5/5/1Kn2:1:1:w')],
        say: 'The timeline is a coordinate too. Capture the knight on L1.',
        solution: '(0T1)c1(1T1)c1',
        wrong: 'The knight is on the same square, one timeline down.',
        ok: 'Straight down one timeline: one move played both boards.',
      },
      {
        type: 'play', goal: goals.to('(0T1)a3', 'That doesn’t capture. Find the knight that differs from your rook in only one coordinate.'),
        at: [small('4k/5/n4/5/K4:0:1:w', '4k/5/n4/5/1K3:0:1:b', '4k/5/5/2n2/1K3:0:2:w', '4k/5/R4/2n2/1K3:0:2:b', '4k/5/R4/2n2/1K3:0:3:w')],
        say: 'Only one knight is within your rook’s reach. Capture it.',
        solution: '(0T3)a3(0T1)a3',
        ok: 'That knight differed from your rook in one coordinate only: the turn.',
      },
      {
        type: 'play',
        at: [small('4k/5/2B2/5/K4:0:1:w', '4k/5/2B2/5/1K3:0:1:b', '4k/5/2Bn1/5/1K3:0:2:w', '4k/5/2Bn1/5/K4:0:2:b', '4k/5/2B2/5/K3n:0:3:w')],
        say: 'A **bishop** changes exactly two coordinates by the same amount. Capture: one file right, one turn back.',
        mark: { arrows: ['(0T3)c3>(0T2)d3'] },
        solution: '(0T3)c3(0T2)d3',
        wrong: 'The knight is one file to the right, one turn back.',
        ok: 'File and turn, one step each: a bishop move through time.',
      },
      {
        type: 'play',
        at: [small('4k/5/2B2/5/K4:0:1:w', '4k/5/2B2/5/1K3:0:1:b', '4k/5/2B2/5/1K3:0:2:w', '4k/5/2B2/5/K4:0:2:b', '4k/5/2B2/5/K4:0:3:w',
          '4k/5/2n2/5/K4:1:2:w', '4k/5/2n2/5/1K3:1:2:b', '4k/5/5/5/1K3:1:3:w', '3k1/5/5/5/1K3:1:3:b')],
        say: 'Same square, one turn back and one timeline down: that’s two coordinates too. Capture the knight.',
        solution: '(0T3)c3(1T2)c3',
        wrong: 'The knight is on c3, on L1, one turn back.',
        ok: 'Turn and timeline together. The capture branched a new timeline, L2: faded, since you were already one ahead.',
      },
      {
        type: 'choose', inactive: true, say: 'A bishop goes one turn back. What else must it do?',
        options: ['Nothing else', 'One step in exactly one other direction', 'Any distance, anywhere'], answer: 1,
        ok: 'Two coordinates, same amount: one turn back means one step in file, rank or timeline.',
      },
    ],
  },
  {
    id: 'queenkingknight', title: 'Queen, king and knight', blurb: 'More directions at once, and jumps.',
    recap: [
      'A queen changes any number of coordinates, all by the same amount.',
      'A king steps once, in any coordinates at once.',
      'A knight moves two in one direction and one in another, any two of the four. It jumps over everything, even the void.',
    ],
    steps: [
      {
        type: 'play',
        at: [small('4k/5/5/2Q2/K4:0:1:w', '4k/5/5/2Q2/1K3:0:1:b', '4k/5/3n1/2Q2/1K3:0:2:w', '4k/5/3n1/2Q2/K4:0:2:b', '4k/5/5/2Q2/K3n:0:3:w')],
        say: 'A **queen** changes any number of coordinates, all by the same amount. Capture: one up, one right, one turn back.',
        mark: { arrows: ['(0T3)c2>(0T2)d3'] },
        solution: '(0T3)c2(0T2)d3',
        wrong: 'The knight is one rank up, one file right and one turn back: three coordinates at once.',
        ok: 'Three coordinates in one move. Queens are fearsome in 5D.',
      },
      {
        type: 'play', at: [small('4k/5/5/5/1K3:0:1:w', '4k/5/5/2n2/5:1:1:w')],
        say: 'A **king** steps once, in any coordinates at once. Capture the knight: one timeline down, one square up and right.',
        mark: { arrows: ['(0T1)b1>(1T1)c2'] },
        solution: '(0T1)b1(1T1)c2',
        wrong: 'Step to c2 on L1: timeline, file and rank, one step each.',
        ok: 'One step through three coordinates. It also played both boards.',
      },
      {
        type: 'play',
        at: [small('k4/5/5/1Nn2/3K1:0:1:w', 'k4/5/5/1Nn2/2K2:0:1:b', 'k4/5/5/1N1n1/2K2:0:2:w', 'k4/5/5/1N1n1/3K1:0:2:b', 'k4/5/5/1N3/3K1:0:3:w')],
        say: 'A **knight** moves two in one direction and one in another: any two. Capture: two files right, one turn back.',
        mark: { arrows: ['(0T3)b2>(0T2)d2'] },
        solution: '(0T3)b2(0T2)d2',
        why: { '(0T3)b2(0T1)c2': 'That works too, but find the one two files right and one turn back.' },
        wrong: 'The knight on d2, one turn back, is two files right of yours.',
        ok: 'Two steps in file, one in time.',
      },
      {
        type: 'play',
        at: [small('k4/5/5/1Nn2/3K1:0:1:w', 'k4/5/5/1Nn2/2K2:0:1:b', 'k4/5/5/1N1n1/2K2:0:2:w', 'k4/5/5/1N1n1/3K1:0:2:b', 'k4/5/5/1N3/3K1:0:3:w')],
        say: 'Now the other knight: one file right, **two** turns back.',
        solution: '(0T3)b2(0T1)c2',
        why: { '(0T3)b2(0T2)d2': 'That one is two files right, one turn back. Find the other.' },
        wrong: 'The knight on c2 two turns back: one file right, two turns back.',
        ok: 'One step in file, two in time.',
      },
      {
        type: 'play',
        at: [small('4k/5/5/5/1NK2:0:1:w', '4k/5/5/5/1N1K1:0:1:b', '3k1/5/5/5/1N1K1:0:2:w', '3k1/5/5/5/1NK2:0:2:b', '4k/5/5/5/1NK2:0:3:w',
          '4k/5/5/5/2K2:-1:4:w', '4k/5/5/5/2K2:1:4:w', '4k/5/5/5/n2K1:2:2:w', '4k/5/5/5/n2K1:2:2:b', '4k/5/5/5/n2K1:2:3:w')],
        say: 'L1 has no board on turn 3: the void. Knights jump right over it. Capture the knight on L2.',
        mark: { voids: ['(1T3w)'] },
        solution: '(0T3)b1(2T3)a1',
        wrong: 'Two timelines down, one file left.',
        ok: 'Over the void! A rook could never pass there.',
      },
    ],
  },
  {
    id: 'pawns', title: 'Pawns', blurb: 'Forward means up the board, and up the timelines.',
    recap: [
      'A pawn moves forward up the board, or forward one timeline (toward the opponent’s timelines).',
      'It captures diagonally: on the board, or one timeline forward and one turn back or ahead.',
      'It never moves straight through time, and promotes on the last rank.',
    ],
    steps: [
      {
        type: 'choose', at: [small('4k/5/5/5/K4:-1:1:w', '4k/5/2P2/5/K4:0:1:w')], predict: true,
        say: 'Black’s timelines are above, so for a white pawn, which way is forward across timelines?',
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
        type: 'play',
        at: [small('4k/5/2P2/5/K4:0:1:w', '4k/5/2P2/5/1K3:0:1:b', '4k/5/2P2/5/1K3:0:2:w', '4k/5/2P2/5/K4:0:2:b', '4k/5/2P2/5/K4:0:3:w',
          '4k/5/2n2/5/K4:-1:2:w', '4k/5/2n2/5/1K3:-1:2:b', '4k/5/5/5/1K3:-1:3:w', '3k1/5/5/5/1K3:-1:3:b')],
        say: 'Pawns capture **diagonally**: on the board, or one timeline forward and one turn back. Capture the knight.',
        mark: { arrows: ['(0T3)c3>(-1T2)c3'] },
        solution: '(0T3)c3(-1T2)c3',
        wrong: 'The knight is one timeline up and one turn back.',
        ok: 'A diagonal capture through time and timeline.',
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
  {
    id: 'check', title: 'Check across time', blurb: 'Threats come from any board.',
    recap: [
      'A king is in check when an enemy piece could capture it next move, from any board.',
      'Escape as in chess: capture the attacker, move the king, or block.',
      'You can’t end your turn with any king in check.',
    ],
    steps: [
      {
        type: 'read', at: [small('4k/5/2N2/5/2K2:0:1:w', '4k/5/5/5/B1r2:1:1:w')], check: true,
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
        type: 'play', at: [small('4k/5/2N2/5/2K2:0:1:w', '4k/5/5/5/B1r2:1:1:w')], check: true,
        goal: ({ moves }) => moves.some((m) => moveLan(m).startsWith('(0T1)c1')) || 'Escape by moving the king this time.',
        say: 'Same check. This time step your **king** out of the rook’s line, play any move on L1, and Submit.',
        solution: '(0T1)c1d2 (1T1)a1b2',
        ok: 'Safe. A king can also escape by capturing across timelines.',
      },
      {
        type: 'choose', at: [small('4k/5/2N2/5/2K2:0:1:w', '4k/5/5/5/B1r2:1:1:w')], check: true,
        say: 'Could you ignore the check and just move other pieces?',
        options: ['Yes', 'No'], answer: 1,
        ok: 'Submit stays disabled while any king of yours could be captured.',
      },
    ],
  },
  {
    id: 'mate', title: 'Checkmate', blurb: 'Leave no escape, in space or in time.',
    recap: [
      'Checkmate: in check, with no legal turn at all. You win.',
      'In 5D, kings can escape through time and across timelines; a mate must stop those too.',
      'Stalemate (no legal turn, not in check) is only a draw.',
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
