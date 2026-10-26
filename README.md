# 5D Chess Lab

Online play, a tutorial, an analysis board, a board editor, checkmate practice and play against an engine
for [5D Chess With Multiverse Time Travel](https://en.wikipedia.org/wiki/5D_Chess_with_Multiverse_Time_Travel),
in your browser: **<https://fireplank.github.io/5d-chess-lab/>**

The engine is [Kairos](https://github.com/FirePlank/5d-chess-engine), compiled to WebAssembly
and run on your own machine (with its helper threads where the browser allows). 5D Chess Lab is
an unofficial fan project, not affiliated with Thunkspace.

- **Home**: create an online game (it waits in the lobby for anyone to accept), challenge a
  friend (a private link), or play Kairos; the lobby is live, and the games being played now are
  shown with their boards and clocks. Behind it, the 5D title screen's vortex and flying pieces
  (after [5dcol](https://github.com/ForkKILLET/5dcol); click a piece, then the same kind of the
  other colour, to annihilate them).
- **Online games** (`#/game/<id>`, after infinitechess.org's): server clocks (none before both
  sides moved; increment, delay and the 5D per-timeline delay), abort before both sides moved,
  resign and draw offers with a second click to confirm, a claim window when the opponent leaves
  (10 s if they closed the page, 60 s if they lost connection), rematch, chat in private games,
  spectators, and every finished game recorded (5dpgn with clocks). Against Kairos the engine
  runs in your browser and its clock waits while you are away. Guests play as anonymous: a random
  token in your browser is their identity.
- **Accounts and rated games**: sign in with Discord or Google to play rated games (both players
  signed in, timed, Standard or Standard - Turn Zero) and keep a rating: Glicko-2 as lichess runs
  it (from 1500 ± 500, provisional while the deviation is 110 or more, the deviation growing back
  while you are away, at most 700 points a game). A Discord account found in the 5D community's
  rating list starts from that rating. Ratings show in the lobby, on the game page (with each
  game's change) and in the records (WhiteElo / BlackElo).
- **Profiles** (`#/player/<id>`, after lichess's): rating ± deviation, the peak, results rated,
  against people and against Kairos (by level), the rating after each rated game as a chart, and
  the games, newest first, against people and against Kairos on separate tabs.
- **Tutorial** (Learn, `#/tutorial`; the home page offers it to first-time visitors, after
  infinitechess.org's "New?" prompt): short lessons that teach 5D chess by doing, in sections
  after lichess.org/learn. The multiverse (boards in time, travel and new timelines, the present,
  moving between timelines and the void, active and inactive timelines), the pieces one by one
  through the four dimensions, fundamentals (check across timelines and through time, checkmate,
  stalemate or mate) and the fairy pieces. Each step asks for one move, click or answer, with
  marks on the board; wrong moves are explained and taken back, with hints that grow on repeated
  misses; every action waits for Submit; stars per lesson are kept in your browser. The lessons
  are data (`static/js/lessons.js`), and `tests/tutorial.mjs` plays every step through the rules
  core (and rejects positions a game could not reach).
- **Checkmate practice** (Learn): the 5D game's practice positions against Kairos defending the
  king, with progress, badges, undo and restart; kept in your browser.
- **Analysis**: paste or drop a game (5dpgn, 5DFEN, a 5DUCI `position … moves …` line, or
  Kairos's JSON records; Ctrl+V loads from the clipboard) and step through it: every timeline
  and turn on one zoomable board, arrows for the last action and for checks, the present, book
  actions marked, recorded evaluations as a graph, and the opening book's theory moves. Kairos
  analyses as you go (depth, score, several lines); moves made on the board build variations
  you can promote, reorder, comment and save.
- **Play**: play Kairos on any built-in variant or a position from analysis or the editor, as either side,
  with a clock (increment and per-timeline delay) or a fixed think time.
- **Openings**: recognized opening names above the move list in Analysis and Play, retained
  after leaving theory and kept with saved games and exports. Classification follows the
  selected variation and works even with engine opening-book play switched off. Browse the
  book on the Openings page through position cards and move breadcrumbs, then analyse or
  play any position. The flat variant selector includes only starts with book moves.
- **Editor**: set up any position: place, move and remove pieces on any board, add boards and
  timelines, select, drag, copy and paste boards and whole timelines, mark unmoved kings, rooks,
  pawns and brawns, and set the board size, odd/even timelines and promotion pieces. The rules
  core checks the position as it changes, and the 5DFEN box edits it both ways.
- **Games**: your online games (from the server) and the analyses you save in your browser
  (IndexedDB): reopen them, rename and annotate the local ones, export them as JSONL.
- **Rules**: how 5D chess works, from moving between boards to timelines and the present.
- **Sounds**: standard Lichess move, capture, castling and game-result cues, with a saved sound toggle
  in the header. Sounds work in Play and while making or reviewing moves in Analysis.

## Layout

| Path | What |
| --- | --- |
| `static/` | The site: plain HTML, CSS and ES modules, no build step |
| `wasm/` | The browser build of the Kairos core (rules, game tree, notation and engine) |
| `server/` | `kairos-web`: serves the site locally, with play against the native engine |
| `supabase/` | Online play: the database (`migrations/`) and the `game` edge function that checks actions with the rules core |
| `games/` | A few game records bundled with the site |
| `tests/` | Node checks of the browser build |
| `scripts/build_pages.sh` | Assembles the static site for GitHub Pages |

The engine is the `kairos` crate from its own repository, a git dependency pinned to one commit
by `Cargo.lock`.

## Running it locally

```bash
rustup target add wasm32-wasip1-threads wasm32-wasip1   # once
cargo wasm                                # the browser build: target/wasm32-wasip1-threads/release/kairos_wasm.wasm
cargo wasm-server                         # the online-play server's single-threaded build (kairos-server.wasm)
cargo web                                 # the server: http://127.0.0.1:8080/
```

Online play talks to the project's Supabase backend from any of these (the URL and publishable
key are in `static/js/net.js`); the local server only serves the pages.

`cargo wasm` and `cargo web` are aliases in `.cargo/config.toml`. The server warns at start if
the browser build is missing or older than its sources. Its options: `--port 8080`,
`--host 0.0.0.0`, `--threads <n>` and `--hash <MB>` for the play engine, `--games <dir>`
(repeatable) and `--archive <file>` (finished games, default `games/web/played.jsonl`). With the
server, Play runs the native engine, one player at a time while others watch and queue; on the
static site every visitor plays their own Kairos in the browser.

To try an engine change before it is pushed, build against a local engine checkout:

```bash
cargo wasm --config 'patch."https://github.com/FirePlank/5d-chess-engine".kairos.path="../5Dchess_engine"'
git checkout Cargo.lock   # afterwards: the override rewrites the pin
```

## Checks

```bash
node tests/smoke.mjs                        # load, view and search through the browser build
node tests/sound.mjs                        # sound events, notation and live-update deduplication
node tests/navigation.mjs                   # WASD panning and analysis position transfer
node tests/openings.mjs                     # named openings, variations and saved-game export
node tests/records.mjs games/sprt/*.jsonl   # replay records: actions, book and eval tags, results
node tests/pgn_corpus.mjs <dir>             # load every 5dpgn file under a directory
node tests/online-sql.mjs                   # the online-play database in PGlite (npm i --prefix .tools @electric-sql/pglite)
node tests/accounts-sql.mjs                 # accounts, the rating import, rated games and profiles in PGlite
node tests/fairplay-sql.mjs                 # admins, a guest's history moving to the account, fair play in PGlite
node tests/fairplay-score.mjs               # fair play's judging, signal rules and bet
node tests/profiles-sql.mjs                 # profiles (renaming, bio, closing), challenges to a player, community
node tests/movesign.mjs                     # the signatures of broadcast actions
deno run -A tests/online-fn.ts              # the game edge function with the rules core (after cargo wasm-server)
```

## Online play (Supabase)

`supabase/migrations/` holds the database: seeks (the lobby and private challenges), live games,
their clocks and presence, chat, the permanent `games` records, and the functions every page
calls (anonymous players pass their token; the database stores only its SHA-256). A pg_cron job
runs the timers every 10 s. `supabase/functions/game/` is the edge function that checks new
games and every action with the Kairos rules core (it fetches the published `kairos-server.wasm`)
before the database applies it. The Supabase GitHub integration deploys both on a push to `main`.

### How an action travels, and the clocks

- **One write per action.** `game_apply_move` works out the action, its clock, the game's end
  and the rating changes first and writes the live row once: realtime sends each page watching
  the game one message per action.
- **Broadcast first.** The mover's page also broadcasts the action on the game's realtime
  channel, signed with a key made for the game (`static/js/movesign.js`: ECDSA P-256, the
  private half never leaves the page, the public half is on the row via `game_key`). The other
  pages check the signature and that the action is legal, and show it at once, before the
  database has it; a reply to it is sent the moment the database confirms it, and if the
  database has another action instead the game is read afresh.
- **Lag compensation (lila's).** The page sends how long the player thought, as it measured it;
  the server's elapsed time (from the action reaching the edge function) beyond that is lag,
  given back from a quota that grows by a gain per action (1 s in long games down to 0.2 s in the
  fastest) up to 7 gains. A page that lies gets at most the gain per action. A flag falls after
  a grace of the side's quota (2 s at most), and an action that comes in time with its lag given
  back is taken.
- **A hidden lobby follows nothing** (no realtime messages, and its connection closes) unless
  your seek waits for an opponent; shown again, it reads the lobby at once. Game pages, for
  players and spectators, stay subscribed.

### Accounts (Supabase Auth)

Signing in links the browser's player token to the account (`account_link`), so every call keeps
working by player id. Two providers need setting up once, in the Supabase dashboard
(Authentication → Sign In / Providers), with this callback URL at both providers:
`https://iazwinlpwqcdamnybzll.supabase.co/auth/v1/callback`.

- **Discord**: discord.com/developers → New Application → OAuth2: add the callback URL as a
  redirect, copy the Client ID and Client Secret into Supabase's Discord provider.
- **Google**: console.cloud.google.com → APIs & Services → Credentials → Create OAuth client ID
  (Web application; consent screen first): the callback URL under "Authorized redirect URIs",
  then the Client ID and Client Secret into Supabase's Google provider.
- **URL configuration** (Authentication → URL Configuration): Site URL
  `https://fireplank.github.io/5d-chess-lab/`, and that URL in Redirect URLs (plus
  `http://localhost:8091/` to sign in from a local server).

The community ratings: `python scripts/import_ratings.py ratings.csv > import.sql` (columns
`discord_id, rating` and optionally `name, rd, vol, games`), then run `import.sql` in the SQL
editor. Keep the list and the SQL out of the repository. A player claims their rating at their
first sign-in with that Discord account (or the next visit, if they signed in before the import),
as long as they haven't played a rated game yet.

### Profiles and the community

A profile (`#/player/<id>`, after lichess's) shows the ratings, the rating history over a chosen
period, the bio, when the player joined and was last seen, and their activity (each day's games and
puzzles) or games. Players edit their name (once every 30 days; their games follow) and bio, or
close their account, from Edit profile; from another player's profile they send a challenge, which
that player sees in the header (the crossed swords) and accepts or declines. Community →
Players lists everyone (online first) and Community → Leaderboard ranks the rated players. The
header's account menu holds the profile links, preferences, sound, theme, board colours and
signing out.

### Admins and fair play

Admins review fair-play cases at `#/admin` and can make other accounts admins or ban them from
their profile pages; the owner's account is an admin from its first sign-in. When a guest signs
in, their games and puzzle history from that browser move into the account. Rated games between
people are analysed after they end by `scripts/fairplay/detect.mjs` on GitHub Actions, started by
the database only when such games are waiting. How it works and its one-time setup (a detector
key, a GitHub token and the admins' Discord webhook): [docs/FAIR_PLAY.md](docs/FAIR_PLAY.md).

## How the site is published

`.github/workflows/pages.yml` builds the browser engine, runs the checks, assembles the site
with `scripts/build_pages.sh` and deploys it to GitHub Pages:

- on every push to `main`, with the engine commit `Cargo.lock` pins;
- when the engine changes: the engine repository notifies this one (`repository_dispatch`,
  if it has a `SITE_DISPATCH_TOKEN` secret), and an hourly check catches anything missed. The
  workflow moves the pin to the engine's latest commit (`cargo update -p kairos`), and only if
  the build and checks pass, commits the new `Cargo.lock` ("Engine abc1234") and deploys;
- by hand, from the Actions tab (Run workflow).

The header shows the site's commit; its tooltip, and every game saved in the browser, name the
engine commit.

## License

GNU General Public License v3.0, see [LICENSE](LICENSE); [NOTICE](NOTICE) lists code from other
projects in the engine. Piece images: see `static/pieces/attributions.txt`.
Sound samples: the standard Lichess theme, also used by Infinite Chess; see
[sound provenance](static/sounds/README.md).
