-- Puzzles for 5D Chess Lab, after lichess's puzzle trainer: Kairos-made puzzles (puzzlegen's site
-- export: the position, the line, and how every step's answers are judged), a Glicko-2 rating for
-- every player and every puzzle, and each player's rounds (the puzzles they have played, so the
-- trainer gives them new ones). Only a player's first round of a puzzle is rated, as on lichess;
-- a round with a hint, or after viewing the solution, is not.
--
-- Players are the anonymous ones of online play (a browser's token, known here by its SHA-256).
-- The puzzles are public (the page judges the answers itself, as lichess's does); rounds and
-- ratings change only through the functions below.

-- ---------------------------------------------------------------------------------- tables

create table public.puzzles (
  id text primary key,
  rating real not null,                  -- Glicko-2, updated by rated rounds
  rd real not null default 250,          -- puzzlegen's estimate starts fairly sure
  vol real not null default 0.09,
  initial_rating integer not null,       -- puzzlegen's estimate
  plays integer not null default 0,      -- rated rounds
  wins integer not null default 0,
  side smallint not null check (side in (1, 2)), -- the solver: 1 white, 2 black
  outcome text not null check (outcome in ('win', 'hold')),
  themes text[] not null,
  position text not null,                -- 5DUCI, with the boards' history
  mate_in smallint,
  ends_in_mate boolean not null default false,
  solution jsonb not null,               -- the line: solver and defender actions alternating
  steps jsonb not null,                  -- per solver action: canonical, keys, reply, accept, variants
  created_at timestamptz not null default now()
);
create index puzzles_rating on public.puzzles (rating);
create index puzzles_themes on public.puzzles using gin (themes);

create table private.puzzle_players (
  player text primary key,
  rating real not null default 1500,
  rd real not null default 500,
  vol real not null default 0.09,
  rounds integer not null default 0,
  updated_at timestamptz not null default now()
);

create table private.puzzle_rounds (
  player text not null,
  puzzle text not null references public.puzzles (id) on delete cascade,
  at timestamptz not null default now(),
  win boolean not null,
  rated boolean not null,
  rating_diff real,                      -- the player's rating change (rated rounds)
  primary key (player, puzzle)
);
create index puzzle_rounds_recent on private.puzzle_rounds (player, at desc);

alter table public.puzzles enable row level security;
alter table private.puzzle_players enable row level security;
alter table private.puzzle_rounds enable row level security;
create policy "Puzzles are public" on public.puzzles for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.puzzles from anon, authenticated;
grant select on public.puzzles to anon, authenticated;

-- ---------------------------------------------------------------------------------- rating

/**
 * One Glicko-2 game: rating `r`, deviation `rd` and volatility `vol` after scoring `score`
 * (1 or 0) against `opp_r`/`opp_rd`, with deviations kept within [`rd_min`, `rd_max`]. The
 * volatility is found by the Illinois method (Glickman's step 5), tau 0.75 as lichess's.
 */
create function private.glicko(r real, rd real, vol real, opp_r real, opp_rd real, score real, rd_min real, rd_max real,
  out new_r real, out new_rd real, out new_vol real) language plpgsql immutable as $$
declare
  k constant double precision := 173.7178;
  tau constant double precision := 0.75;
  mu double precision := (r - 1500) / k;
  phi double precision := rd / k;
  mu_j double precision := (opp_r - 1500) / k;
  phi_j double precision := opp_rd / k;
  g double precision := 1 / sqrt(1 + 3 * phi_j ^ 2 / pi() ^ 2);
  e double precision := 1 / (1 + exp(-g * (mu - mu_j)));
  v double precision := 1 / (g ^ 2 * e * (1 - e));
  delta double precision := v * g * (score - e);
  a double precision := ln(vol ^ 2);
  aa double precision; bb double precision; cc double precision;
  fa double precision; fb double precision; fc double precision;
  sigma double precision; phi_star double precision; phi_new double precision;
  i integer := 0;
begin
  aa := a;
  if delta ^ 2 > phi ^ 2 + v then
    bb := ln(delta ^ 2 - phi ^ 2 - v);
  else
    bb := a - tau;
    while (exp(bb) * (delta ^ 2 - phi ^ 2 - v - exp(bb)) / (2 * (phi ^ 2 + v + exp(bb)) ^ 2) - (bb - a) / tau ^ 2) < 0 and i < 50 loop
      bb := bb - tau;
      i := i + 1;
    end loop;
  end if;
  fa := exp(aa) * (delta ^ 2 - phi ^ 2 - v - exp(aa)) / (2 * (phi ^ 2 + v + exp(aa)) ^ 2) - (aa - a) / tau ^ 2;
  fb := exp(bb) * (delta ^ 2 - phi ^ 2 - v - exp(bb)) / (2 * (phi ^ 2 + v + exp(bb)) ^ 2) - (bb - a) / tau ^ 2;
  i := 0;
  while abs(bb - aa) > 0.000001 and i < 100 loop
    cc := aa + (aa - bb) * fa / (fb - fa);
    fc := exp(cc) * (delta ^ 2 - phi ^ 2 - v - exp(cc)) / (2 * (phi ^ 2 + v + exp(cc)) ^ 2) - (cc - a) / tau ^ 2;
    if fc * fb <= 0 then
      aa := bb; fa := fb;
    else
      fa := fa / 2;
    end if;
    bb := cc; fb := fc;
    i := i + 1;
  end loop;
  sigma := least(exp(aa / 2), 0.1);
  phi_star := sqrt(phi ^ 2 + sigma ^ 2);
  phi_new := 1 / sqrt(1 / phi_star ^ 2 + 1 / v);
  phi_new := greatest(rd_min / k, least(rd_max / k, phi_new));
  new_r := greatest(400, least(4000, k * (mu + phi_new ^ 2 * g * (score - e)) + 1500));
  new_rd := k * phi_new;
  new_vol := sigma;
end $$;

-- ---------------------------------------------------------------------------------- functions

/** The player's puzzle rating row (made on first use). */
create function private.puzzle_player(p text) returns private.puzzle_players language plpgsql as $$
declare
  row private.puzzle_players;
begin
  insert into private.puzzle_players (player) values (p) on conflict (player) do nothing;
  select * into row from private.puzzle_players where player = p;
  return row;
end $$;

/** The page's view of a puzzle: everything but the bookkeeping. */
create function private.puzzle_json(z public.puzzles) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'id', z.id, 'rating', round(z.rating), 'plays', z.plays, 'side', case z.side when 1 then 'white' else 'black' end,
    'outcome', z.outcome, 'themes', to_jsonb(z.themes), 'position', z.position, 'mate_in', z.mate_in,
    'ends_in_mate', z.ends_in_mate, 'solution', z.solution, 'steps', z.steps)
$$;

/**
 * The next puzzle for the player: in `p_theme` (null: any); within [`p_min`, `p_max`] when
 * given (any one of them), else the closest to the player's rating moved by `p_offset`
 * (lichess's difficulty: -600 easiest to +600 hardest), with some spread so that the same
 * rating does not always give the same puzzle; never one in `p_skip` (this session's), and not
 * one already played unless `p_replay` (then the unplayed come first). Null when none is left.
 */
create function public.puzzle_next(p_token text, p_theme text default null, p_min integer default null,
  p_max integer default null, p_offset integer default 0, p_skip text[] default '{}', p_replay boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.pid(p_token);
  pl private.puzzle_players := private.puzzle_player(me);
  target real := pl.rating + greatest(-600, least(600, coalesce(p_offset, 0)));
  z public.puzzles;
begin
  if p_min is not null and p_max is null then target := greatest(target, p_min); end if;
  if p_max is not null and p_min is null then target := least(target, p_max); end if;
  select * into z from public.puzzles q
   where (p_theme is null or q.themes @> array[p_theme])
     and (p_min is null or q.rating >= p_min) and (p_max is null or q.rating <= p_max)
     and not (q.id = any (coalesce(p_skip, '{}')))
     and (p_replay or not exists (select 1 from private.puzzle_rounds r where r.player = me and r.puzzle = q.id))
   order by (exists (select 1 from private.puzzle_rounds r where r.player = me and r.puzzle = q.id)),
     case when p_min is not null and p_max is not null then random() else abs(q.rating - target) + random() * 120 end
   limit 1;
  if z.id is null then return null; end if;
  return private.puzzle_json(z);
end $$;

/** One puzzle by id (for links), with whether and how the player has played it. */
create function public.puzzle_get(p_token text, p_id text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.pid(p_token);
  z public.puzzles;
  r private.puzzle_rounds;
begin
  select * into z from public.puzzles where id = p_id;
  if z.id is null then return null; end if;
  select * into r from private.puzzle_rounds where player = me and puzzle = p_id;
  return private.puzzle_json(z) || jsonb_build_object('played', r.puzzle is not null, 'won', r.win);
end $$;

/**
 * The player finished a puzzle: won (solved without a mistake) or not, rated or not (no hint,
 * no solution). The first round of a puzzle is kept and, when rated, moves both ratings (the
 * deviations stay within 45-500 for players, 60-500 for puzzles); later rounds change
 * nothing. Returns the player's rating, the change, and the puzzle's rating and plays.
 */
create function public.puzzle_round(p_token text, p_id text, p_win boolean, p_rated boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.pid(p_token);
  pl private.puzzle_players := private.puzzle_player(me);
  z public.puzzles;
  mine record;
  theirs record;
  diff real := null;
begin
  select * into z from public.puzzles where id = p_id for update;
  if z.id is null then raise exception 'no such puzzle' using errcode = 'P0001'; end if;
  if exists (select 1 from private.puzzle_rounds where player = me and puzzle = p_id) then
    return jsonb_build_object('rating', round(pl.rating), 'rd', round(pl.rd), 'diff', null, 'first', false,
      'puzzle_rating', round(z.rating), 'puzzle_plays', z.plays, 'rounds', pl.rounds);
  end if;
  if p_rated then
    select * into mine from private.glicko(pl.rating, pl.rd, pl.vol, z.rating, z.rd, case when p_win then 1 else 0 end, 45, 500);
    select * into theirs from private.glicko(z.rating, z.rd, z.vol, pl.rating, pl.rd, case when p_win then 0 else 1 end, 60, 500);
    diff := mine.new_r - pl.rating;
    update private.puzzle_players set rating = mine.new_r, rd = mine.new_rd, vol = mine.new_vol,
      rounds = rounds + 1, updated_at = now() where player = me returning * into pl;
    update public.puzzles set rating = theirs.new_r, rd = theirs.new_rd, vol = theirs.new_vol,
      plays = plays + 1, wins = wins + case when p_win then 1 else 0 end where id = p_id returning * into z;
  end if;
  insert into private.puzzle_rounds (player, puzzle, win, rated, rating_diff) values (me, p_id, p_win, p_rated, diff);
  return jsonb_build_object('rating', round(pl.rating), 'rd', round(pl.rd), 'diff', round(diff), 'first', true,
    'puzzle_rating', round(z.rating), 'puzzle_plays', z.plays, 'rounds', pl.rounds);
end $$;

/**
 * The puzzle dashboard: the player's rating, their totals, every theme's puzzles (all, and
 * within [`p_min`, `p_max`] when given) with how many the player has played and solved, and the
 * player's latest rounds.
 */
create function public.puzzle_dashboard(p_token text, p_min integer default null, p_max integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.pid(p_token);
  pl private.puzzle_players := private.puzzle_player(me);
begin
  return jsonb_build_object(
    'rating', round(pl.rating), 'rd', round(pl.rd), 'rated', pl.rounds,
    'played', (select count(*) from private.puzzle_rounds where player = me),
    'solved', (select count(*) from private.puzzle_rounds where player = me and win),
    'total', (select count(*) from public.puzzles),
    'range', (select jsonb_build_object('min', floor(min(rating)), 'max', ceil(max(rating))) from public.puzzles),
    'themes', coalesce((
      select jsonb_agg(jsonb_build_object('theme', t.theme, 'total', t.total, 'in_range', t.in_range,
        'played', t.played, 'solved', t.solved, 'left', t.left_in_range) order by t.theme)
      from (
        select th as theme, count(*) as total,
          count(*) filter (where (p_min is null or q.rating >= p_min) and (p_max is null or q.rating <= p_max)) as in_range,
          count(r.puzzle) as played, count(r.puzzle) filter (where r.win) as solved,
          count(*) filter (where r.puzzle is null and (p_min is null or q.rating >= p_min) and (p_max is null or q.rating <= p_max)) as left_in_range
        from public.puzzles q
        cross join lateral unnest(q.themes) th
        left join private.puzzle_rounds r on r.player = me and r.puzzle = q.id
        group by th) t), '[]'::jsonb),
    'left', (select count(*) from public.puzzles q
      where (p_min is null or q.rating >= p_min) and (p_max is null or q.rating <= p_max)
        and not exists (select 1 from private.puzzle_rounds r where r.player = me and r.puzzle = q.id)),
    'recent', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.puzzle, 'win', x.win, 'rated', x.rated, 'diff', round(x.rating_diff),
        'at', x.at, 'rating', round(x.rating), 'themes', to_jsonb(x.themes)) order by x.at desc)
      from (select r.*, q.rating, q.themes from private.puzzle_rounds r join public.puzzles q on q.id = r.puzzle
            where r.player = me order by r.at desc limit 60) x), '[]'::jsonb));
end $$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function public.puzzle_next, public.puzzle_get, public.puzzle_round, public.puzzle_dashboard to anon, authenticated;
