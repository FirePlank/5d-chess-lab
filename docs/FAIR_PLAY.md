# Fair play

How 5D Chess Lab looks for engine assistance in rated games. The detector is public, like
infinitechess.org's and lichess's: knowing how it works doesn't help a cheater much, and
players can check that it is fair.

The design follows infinitechess.org's detector (its `CHEAT_DETECTION.md`), with the page
signals lichess collects:

- **Only after the game.** Nothing runs during a game; a finished rated game between two
  people is analysed afterwards.
- **A fixed search.** Every position gets the same search: Kairos single-threaded, 800,000
  nodes, 5 lines (`NODES`, `MULTIPV` in `static/js/fairplay-score.js`). That is about what a
  player gets from the analysis board in 10 seconds, the most a cheater could spend on most
  actions.
- **Flag, never ban automatically.** The detector opens a case and posts it to the admins'
  Discord channel; an admin reviews it and dismisses it or bans the player (barred from rated
  games). Nothing bans anyone on its own, in any case.
- **The player against themself.** The search is noisy, so the strongest evidence compares a
  player with their own play: the analysis board showing their live position, engine matches
  on the turns they spent away from the game's page against the turns they didn't, and think
  times as even as a program's. The engine-match score (calibrated on human games) adds the
  rest.
- **Page signals only add suspicion.** What the page measured can only count against a player:
  the page is theirs to change, so a clean signal proves nothing.
- **A dismissal clears the past.** A dismissed case's evidence never counts toward another
  case.
- **Games against Kairos are not analysed.** The engine would only be checked against itself.
  Their page signals are still kept.

## Pieces

| Piece | What it does |
| --- | --- |
| `static/js/fairplay.js` | The page's signals per action, the browser fingerprint, the cross-tab guard, and the analysis board's reports. |
| `supabase/functions/game` | Accepts the signals with the action, after sanitising them, and hashes the position after it. |
| `supabase/migrations/20261025120000_admins_fairplay.sql` | Admins, signals, the queue, evidence, cases, review and the dispatcher. |
| `scripts/fairplay/detect.mjs` | The detector (silent): analyses, stores the evidence, opens cases and posts them to Discord. |
| `scripts/fairplay/collect.mjs`, `fit.mjs` | The calibration: human games analysed as the detector does, and the model fitted on them. |
| `.github/workflows/fairplay.yml` | Runs the detector on GitHub Actions. |
| `static/js/fairplay-score.js` | Evidence and the betting score. Shared by the detector and the review page. |
| `static/js/admin.js` | The admins' review page (`#/admin`), and admin controls on profiles. |

## Page signals

While a player has a turn in an online game against a person, the game's page measures:

- how long the turn took;
- how long the page was hidden or out of focus, and how often;
- when the player first touched the board;
- the browser's fingerprint: a hash of what it shows every site (user agent, languages, screen,
  time zone, cores, and how it draws text), the same in a private window or another profile of
  the same browser.

The measurements go with the action to the server, which keeps them in `private.move_signals`
for 180 days. No one but admins can read them.

**The same browser.** The browser's tabs talk over a BroadcastChannel. The game's tab announces
its live position every 2 seconds. While an announcement is fresh:

- Another tab's engine refuses to search, and the game's tab records `engine_paused`.
- An analysis board showing the game's exact position (after action 6) makes the game's tab
  record `engine_tab`. One such turn opens a case.

**Another window or device.** While a rated game between people is live, the edge function
hashes each position from the actions (the rules core's boards, not anything a page sends), and
the database keeps each player's browser fingerprint. The analysis board, on any device, signed
in or not, reports the hash of what it shows with its browser's fingerprint (`fairplay_seen`;
when the server says there is no live game of this account or browser, it stays quiet for a
minute). The database keeps a match when the position is the live game's current one, from
action 6 on, for the player whose account the board is signed in with (`via: account`) or whose
browser fingerprint it has (`via: browser`). A spectator is someone else's account, and almost
always another fingerprint; but two identical machines can share one, so a match is evidence,
not proof: it takes matches on 2 turns of a game (`DEVICE_MATCHES`) to open a case. Reports that
don't match are not stored.

## Cases

The detector opens a case (one open case per player at a time) for:

| Reason | When |
| --- | --- |
| `engine-tab` | Another tab of the player's browser showed their live position on the analysis board, on any turn. |
| `analysis-match` | Their analysis board in another window or on another device (their account or browser) showed their live position, on 2 turns of one game. |
| `away` | Over their recent games, Kairos's first choice on turns they spent away from the page (hidden or unfocused 3 s or more, `AWAY_MS`) much more often than on their other turns: at least 10 away turns, a gap of 25 points and a z-score of 3 (`AWAY`). |
| `timing` | Over their recent games, think times as even as a program's: at least 30 turns, 2 s on average or more, with a coefficient of variation under 0.25 (`TIMING`). |
| `moves` | Their engine-match score passes the case line (below). |

The page's signal rules compare a player with themself, so their strength and the search's
noise cancel out. The human games the model is calibrated on have no page signals, so these
thresholds are set by hand, conservatively; each case keeps the numbers that opened it, to tune
them on this site's own games.

## Evidence

For each action of a rated game, Kairos analyses the position before it. An action is:

- **top** if it is Kairos's first line;
- **good** if it loses at most 5% win probability (Kairos's win/draw/loss; infinitechess.org uses 2%, but Kairos's estimate wobbles by more than that at this depth in 5D);
- **miss** otherwise.

Some positions are left out: those with one legal action, and decided positions (best line
above 97% or below 3%).

Each judged action also records how hard the position was:

| Field | Meaning |
| --- | --- |
| `goodMoves` | How many of the 5 lines are good. |
| `shallowFinds` | Whether Kairos's depth-3 choice is good. |
| `deepFind` | Whether the best action only settled at depth 7 or later. |
| `bestCaptures` | Whether the best action captures. |
| `inCheck` | Whether the player was in check. |
| `bestTravels` | Whether the best action crosses boards. Recorded for calibration, not used by the model yet. |

## The score

The score is a betting score, as at infinitechess.org.

For each action, it compares two likelihoods:

- how likely a top, good or miss was for an engine user;
- how likely it was for an honest player as strong as the strongest players in the calibration
  data (the same ceiling for every rating, so everyone is compared with the best).

These ratios are bet with four cheating fractions (10%, 25%, 50%, 100% of actions) and
averaged.

A player's score is the best over every run of recent games ending with the latest:

- only games from the last six months count;
- games before the last dismissal don't count.

A case opens when the score passes the case line **and** the player has at least 3 assessed
games (`CASE_LOG_SCORE`, `MIN_GAMES`).

**Calibration.** `GOOD_LOSS`, `MODEL` and `CASE_LOG_SCORE` are fitted by
`scripts/fairplay/fit.mjs` on 222 rated Turn Zero games between the strongest community players
(2021–2025, before any 5D engine was strong). `collect.mjs` analyses each position as the
detector does (800k nodes, 5 lines) and, in the same positions, plays Kairos's own action at a
cheater's budgets (200k, 600k and 1.5M nodes).

| | Top | Good | Miss |
| --- | --- | --- | --- |
| The players' actions | 34% | 18% | 48% |
| Kairos's actions | 65% | 25% | 10% |

(At the chosen good-action threshold of 3% win probability. Kairos's own actions sometimes miss:
its evaluation wobbles at this depth, which is why the engine-match score alone is never proof.)

The case line is ten times the highest score honest histories reach: every real player's
history, 99.9% of 30-game histories drawn from all the games, and 99.9% of each player's own
games reordered. Every game is scored by a model fitted without it. The line comes to about 71 to
1 (`CASE_LOG_SCORE` 4.26). At it, simulated cheaters fare as follows:

| Actions from Kairos | Caught (median) | Within 10 games | Within 30 games |
| --- | --- | --- | --- |
| All | 3 games | 100% | 100% |
| Half | 22 games | 24% | 71% |
| A quarter | — | 0% | 0% |

Occasional engine use is left to the page signals. Refit on this site's own games once there are
enough:

```sh
node scripts/fairplay/collect.mjs target/fairplay/site.jsonl <dir of .5dpgn> <worker> <workers>
node scripts/fairplay/fit.mjs target/fairplay/site.jsonl
```

## Running

pg_cron calls `private.fairplay_dispatch()` every 15 minutes. It starts the workflow only when
both hold:

- a rated game between people ended since the last look and is still unassessed;
- no run started in the last 10 minutes.

A quiet site starts nothing. Each run takes every waiting game, older ones too.

The workflow downloads the published `kairos.wasm` and runs `detect.mjs`. **The logs of this
repository's runs are public, so the detector prints nothing**; only its exit code says
whether it worked.

Setup, once:

1. **The detector's key.** The migration stores the SHA-256 of a random key in
   `private.detector_keys`; the key itself is this repository's Actions secret `FAIRPLAY_KEY`.
   To replace it, insert the new key's hash:
   ```sql
   insert into private.detector_keys (hash) values (encode(extensions.digest('<key>', 'sha256'), 'hex'));
   ```
2. **A GitHub token for the dispatcher.** A fine-grained personal access token with access to
   this repository only and the permission Actions: Read and write, in Supabase Vault:
   ```sql
   select vault.create_secret('<token>', 'github_fairplay_token');
   ```
   `select public.fairplay_ready()` says whether the database can start the detector (pg_net and
   the token; never the token itself). Without it, nothing starts on its own; the workflow can
   still be run by hand from the Actions tab. Renew the token before it expires.
3. **The admins' Discord channel.** Every new case is posted there by the detector, with a link
   to its review. The channel's webhook URL is the Actions secret `FAIRPLAY_DISCORD_WEBHOOK`
   (never in this repository).

## Reviewing

Each new case is posted to the admins' Discord channel. Admins see a **Fair play** link in the
header, with the number of open cases. A case shows:

- the player, and why the case opened;
- the score when it opened, and now;
- the player's away turns (and how often Kairos's first choice came on them and on the others),
  and their think times;
- every game that counts: top/good/miss counts, the game's score, and the player's think
  times;
- the player's most telling actions in each game: how hard the position was, the loss, the
  think time from the clocks, the first touch, and what the page saw (including analysis-board
  matches, and whether by account or by browser).

**Dismiss** clears the player: their evidence so far stops counting. **Ban** bars them from
rated games. An admin can lift a ban, or make another account an admin, from the player's
profile.

The site's owner account is an admin from its first sign-in (`private.admin_seed`).
