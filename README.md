# 5D Chess Lab

An analysis board, a board editor and play against an engine for
[5D Chess With Multiverse Time Travel](https://en.wikipedia.org/wiki/5D_Chess_with_Multiverse_Time_Travel),
all in your browser: **<https://fireplank.github.io/5d-chess-lab/>**

The engine is [Kairos](https://github.com/FirePlank/5d-chess-engine), compiled to WebAssembly
and run on your own machine (with its helper threads where the browser allows). 5D Chess Lab is
an unofficial fan project, not affiliated with Thunkspace.

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
- **Games**: your games against Kairos and the analyses you save, kept in your browser
  (IndexedDB): rename them, add notes, reopen them, export them as JSONL.
- **Rules**: how 5D chess works, from moving between boards to timelines and the present.
- **Sounds**: standard Lichess move, capture, castling and game-result cues, with a saved sound toggle
  in the header. Sounds work in Play and while making or reviewing moves in Analysis.

## Layout

| Path | What |
| --- | --- |
| `static/` | The site: plain HTML, CSS and ES modules, no build step |
| `wasm/` | The browser build of the Kairos core (rules, game tree, notation and engine) |
| `server/` | `kairos-web`: serves the site locally, with play against the native engine |
| `games/` | A few game records bundled with the site |
| `tests/` | Node checks of the browser build |
| `scripts/build_pages.sh` | Assembles the static site for GitHub Pages |

The engine is the `kairos` crate from its own repository, a git dependency pinned to one commit
by `Cargo.lock`.

## Running it locally

```bash
rustup target add wasm32-wasip1-threads   # once
cargo wasm                                # the browser build: target/wasm32-wasip1-threads/release/kairos_wasm.wasm
cargo web                                 # the server: http://127.0.0.1:8080/
```

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
```

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
