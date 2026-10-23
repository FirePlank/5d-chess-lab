-- Online play for 5D Chess Lab: the lobby (seeks), private challenges, live games (between two
-- people, or against Kairos running in the player's browser), their clocks, disconnects, draws,
-- rematches and chat, and the permanent record of every finished game. The design follows
-- infinitechess.org's server (its redesign branch): one seek per player, the seek id is the game
-- id, clocks start once both sides have moved, a claim window opens when an opponent leaves (10 s
-- if they left on purpose, 60 s if they lost connection, after a 5 s cushion), a game where every
-- person has been gone 5 minutes ends by abandonment, and a game is logged the moment it ends.
--
-- Players are anonymous: a browser keeps a random token, and the database knows the player only
-- by its SHA-256 (the "player id"). Every change goes through the functions below (security
-- definer); the tables are readable where the site shows them and writable by nobody else.
-- Moves come through the `game` edge function, which checks them with the Kairos rules core and
-- then calls game_apply_move (service role only).

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------------- tables

-- Open seeks: public ones are the lobby, private ones are "Challenge a friend" links. The id is
-- the id the game will have.
create table public.seeks (
  id text primary key,
  created_at timestamptz not null default now(),
  owner text not null,                   -- player id
  owner_tab text not null,               -- the tab the seek was made from (it is taken into the game)
  private boolean not null,
  variant text not null,                 -- a built-in variant's name, or 'Custom'
  position text not null,                -- 5DUCI start position
  setup text not null,                   -- 5dpgn headers of the start (for the record)
  start_to_move smallint not null check (start_to_move in (1, 2)),
  start_active integer not null default 1,
  base_ms integer,                       -- null: untimed
  inc_ms integer not null default 0,
  delay_ms integer not null default 0,
  tl_delay_ms integer not null default 0,
  color smallint check (color in (1, 2)),-- the owner's side; null: random
  owner_away_since timestamptz,          -- private: when the owner's last challenge page closed
  owner_left_voluntarily boolean not null default false
);
create unique index seeks_one_per_owner on public.seeks (owner);

-- Who is in a live (unfinished) game, so that nobody plays two at once, and so that every tab of
-- theirs learns of it ("You're already in a game", or the tab that asked navigates to it).
create table public.active_players (
  player text primary key,
  game_id text not null,
  role smallint not null check (role in (1, 2)),
  navigate_tab text,                     -- the tab to take into the game
  created_at timestamptz not null default now()
);

create table public.live_games (
  id text primary key,
  created_at timestamptz not null default now(),
  variant text not null,
  position text not null,
  setup text not null,
  start_to_move smallint not null,
  start_active integer not null default 1,
  private boolean not null default false,
  base_ms integer,
  inc_ms integer not null default 0,
  delay_ms integer not null default 0,
  tl_delay_ms integer not null default 0,
  white text,                            -- player ids; null on Kairos's side
  black text,
  white_tab text,                        -- the tab holding the game for each player
  black_tab text,
  engine_color smallint check (engine_color in (1, 2)),
  engine text,
  engine_version text,
  engine_level smallint,
  engine_book boolean,
  engine_frozen boolean not null default false,
  moves jsonb not null default '[]'::jsonb,   -- [{lan, san, full, lone, clk}]
  ply integer not null default 0,
  to_move smallint not null check (to_move in (1, 2)),
  white_ms bigint,                       -- clock snapshots at turn_started_at
  black_ms bigint,
  color_ticking smallint,                -- whose clock runs; null before 2 plies, untimed, frozen or over
  turn_started_at timestamptz,
  turn_delay_ms integer not null default 0,
  active_timelines integer not null default 1,
  draw_offer smallint,                   -- the side with an open draw offer
  white_last_offer_ply integer,
  black_last_offer_ply integer,
  white_claim_at timestamptz,            -- the opponent of a side that left may claim from then
  black_claim_at timestamptz,
  white_claim_voluntary boolean,
  black_claim_voluntary boolean,
  empty_since timestamptz,               -- every person in the game is gone since then
  white_rematch boolean not null default false,
  black_rematch boolean not null default false,
  white_gone boolean not null default false, -- after the game: left the page
  black_gone boolean not null default false,
  rematch_id text,
  chat_count integer not null default 0,
  result text,
  termination text,
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Every page of every player that the server must know about: the lobby (a public seek lives
-- while its owner is there), a challenge page, a game. Pinged every 5 s; `left` when the page
-- closed on purpose.
create table private.presence (
  player text not null,
  tab text not null,
  page text not null check (page in ('lobby', 'challenge', 'game')),
  ref text,
  seen_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (player, tab)
);
create index presence_ref on private.presence (page, ref);

create table private.chat_entries (
  id bigserial primary key,
  game_id text not null,
  idx integer not null,
  player smallint,                       -- 1 or 2: who wrote it or caused the notice
  message text,
  notice text,
  sent_at timestamptz not null default now(),
  check ((message is null) <> (notice is null)),
  unique (game_id, idx)
);

-- When a player last created something (seeks and games), against floods.
create table private.recent (
  player text primary key,
  at timestamptz not null default now()
);

-- Finished games (one row each, written the moment the game ends; never one with no moves).
create table public.games (
  id text primary key,
  created_at timestamptz not null,       -- when the game started
  ended_at timestamptz not null,
  variant text not null,
  position text not null,
  base_ms integer,
  inc_ms integer not null default 0,
  delay_ms integer not null default 0,
  tl_delay_ms integer not null default 0,
  private boolean not null default false,
  result text not null check (result in ('1-0', '0-1', '1/2-1/2', '*')),
  termination text not null,
  move_count integer not null check (move_count > 0),
  duration_ms bigint,
  white_name text not null,
  black_name text not null,
  moves jsonb not null,                  -- [{lan, san, full, lone, clk}]
  record text not null                   -- 5dpgn with headers and [%clk] comments
);
create index games_created on public.games (created_at desc);

create table public.player_games (
  game_id text not null references public.games (id) on delete cascade,
  color smallint not null check (color in (1, 2)),
  player text not null,
  score real,                            -- 1, 0.5, 0; null if aborted
  clock_at_end_ms bigint,
  primary key (game_id, color)
);
create index player_games_player on public.player_games (player, game_id);

create table public.engine_games (
  game_id text not null references public.games (id) on delete cascade,
  color smallint not null check (color in (1, 2)),
  score real,
  clock_at_end_ms bigint,
  engine text not null,
  engine_version text not null,
  strength_level smallint not null,
  primary key (game_id, color)
);

-- ---------------------------------------------------------------------------------- access

alter table public.seeks enable row level security;
alter table public.active_players enable row level security;
alter table public.live_games enable row level security;
alter table public.games enable row level security;
alter table public.player_games enable row level security;
alter table public.engine_games enable row level security;
alter table private.presence enable row level security;
alter table private.chat_entries enable row level security;
alter table private.recent enable row level security;

-- Public seeks are the lobby; a private one is reached only through its link (challenge_open).
create policy "Public seeks are listed" on public.seeks for select to anon, authenticated using (not private);
create policy "Who is in a game is public" on public.active_players for select to anon, authenticated using (true);
create policy "Live games can be watched" on public.live_games for select to anon, authenticated using (true);
create policy "Finished games are public" on public.games for select to anon, authenticated using (true);
create policy "Game players are public" on public.player_games for select to anon, authenticated using (true);
create policy "Engine players are public" on public.engine_games for select to anon, authenticated using (true);

revoke insert, update, delete, truncate on public.seeks, public.active_players, public.live_games,
  public.games, public.player_games, public.engine_games from anon, authenticated;
grant select on public.seeks, public.active_players, public.live_games, public.games,
  public.player_games, public.engine_games to anon, authenticated;

-- Live changes reach the lobby, challenge and game pages through Supabase Realtime.
alter table public.seeks replica identity full;
alter table public.active_players replica identity full;
alter table public.live_games replica identity full;
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.seeks, public.active_players, public.live_games;
  end if;
end $$;

-- ---------------------------------------------------------------------------------- constants

create function private.c(name text) returns interval language sql immutable as $$
  select case name
    when 'stale' then interval '12 seconds'          -- no ping for this long: the page is gone (involuntarily)
    when 'cushion' then interval '5 seconds'         -- then a reconnect cushion before the opponent hears of it
    when 'claim_voluntary' then interval '10 seconds'
    when 'claim_involuntary' then interval '60 seconds'
    when 'abandonment' then interval '5 minutes'     -- every person gone this long: the game ends
    when 'challenge_expiry' then interval '10 minutes'
    when 'flood' then interval '2 seconds'
  end
$$;

-- ---------------------------------------------------------------------------------- helpers

/** The player id of a token (its SHA-256 in hex); throws on a malformed token. */
create function private.pid(token text) returns text language plpgsql immutable as $$
begin
  if token is null or length(token) < 20 or length(token) > 128 or token !~ '^[A-Za-z0-9_-]+$' then
    raise exception 'bad player token' using errcode = '22023';
  end if;
  return encode(extensions.digest(token, 'sha256'), 'hex');
end $$;

create function private.check_tab(tab text) returns text language plpgsql immutable as $$
begin
  if tab is null or tab !~ '^[A-Za-z0-9]{4,16}$' then raise exception 'bad tab id' using errcode = '22023'; end if;
  return tab;
end $$;

/** A new game id: 6 base62 characters, unused by any seek, live game or finished game. */
create function private.new_id() returns text language plpgsql volatile as $$
declare
  alphabet constant text := '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  v text;
begin
  loop
    v := '';
    for i in 1..6 loop v := v || substr(alphabet, 1 + floor(random() * 62)::int, 1); end loop;
    exit when not exists (select 1 from public.seeks s where s.id = v)
      and not exists (select 1 from public.live_games g where g.id = v)
      and not exists (select 1 from public.games g where g.id = v);
  end loop;
  return v;
end $$;

create function private.ms(i interval) returns bigint language sql immutable as $$
  select (extract(epoch from i) * 1000)::bigint
$$;

/** Refuse a second creation within the flood interval. */
create function private.flood(p text) returns void language plpgsql as $$
begin
  if exists (select 1 from private.recent r where r.player = p and r.at > clock_timestamp() - private.c('flood')) then
    raise exception 'Please wait a moment before starting another game.' using errcode = 'P0001';
  end if;
  insert into private.recent (player, at) values (p, clock_timestamp())
    on conflict (player) do update set at = excluded.at;
end $$;

/** The side (1 white, 2 black) player p plays in game g, or null. */
create function private.side(g public.live_games, p text) returns smallint language sql immutable as $$
  select case when g.white = p then 1::smallint when g.black = p then 2::smallint end
$$;

create function private.player_of(g public.live_games, side smallint) returns text language sql immutable as $$
  select case side when 1 then g.white else g.black end
$$;

/** Whether the person playing `side` of game g has a live page on it. */
create function private.connected(g public.live_games, side smallint) returns boolean language sql stable as $$
  select exists (
    select 1 from private.presence pr
    where pr.player = private.player_of(g, side) and pr.page = 'game' and pr.ref = g.id
      and pr.tab = case side when 1 then g.white_tab else g.black_tab end
      and pr.left_at is null and pr.seen_at > clock_timestamp() - private.c('stale'))
$$;

/** Append a chat line (a message, or a notice code) and bump the game's chat count. */
create function private.notice(gid text, who smallint, code text, msg text default null) returns void language plpgsql as $$
declare n integer;
begin
  update public.live_games set chat_count = chat_count + 1, updated_at = clock_timestamp() where id = gid returning chat_count into n;
  if n is null then return; end if;
  insert into private.chat_entries (game_id, idx, player, notice, message) values (gid, n - 1, who, case when msg is null then code end, msg);
end $$;

/** The clock time left for `side` right now (null untimed). */
create function private.time_left(g public.live_games, side smallint, at timestamptz) returns bigint language sql stable as $$
  select case
    when g.base_ms is null then null
    when g.color_ticking = side then
      (case side when 1 then g.white_ms else g.black_ms end)
        - greatest(0, private.ms(at - g.turn_started_at) - g.turn_delay_ms)
    else case side when 1 then g.white_ms else g.black_ms end
  end
$$;

/** "0:04:58.2" for a [%clk] comment. */
create function private.clk(ms bigint) returns text language sql immutable as $$
  select format('%s:%s:%s.%s', ms / 3600000, lpad(((ms / 60000) % 60)::text, 2, '0'),
    lpad(((ms / 1000) % 60)::text, 2, '0'), (ms % 1000) / 100)
$$;

create function private.termination_text(g public.live_games) returns text language sql immutable as $$
  select case g.termination
    when 'checkmate' then 'Checkmate'
    when 'exiled' then 'Exiled kings'
    when 'stalemate' then 'Stalemate'
    when 'time' then 'Time forfeit'
    when 'resignation' then 'Resignation'
    when 'disconnect' then 'Abandonment'
    when 'abandonment' then 'Abandonment'
    when 'agreement' then 'Agreement'
    when 'aborted' then 'Aborted'
    else g.termination end
$$;

create function private.name_of(g public.live_games, side smallint) returns text language sql immutable as $$
  select case when g.engine_color = side then
      case when g.engine_level >= 8 then 'Kairos' else format('Kairos (Level %s)', g.engine_level) end
    else 'Anonymous' end
$$;

/** The finished game as 5dpgn: its start's headers, the game's, and every action with its clock. */
create function private.record(g public.live_games) returns text language plpgsql stable as $$
declare
  head text;
  body text := '';
  m jsonb;
  i integer := 0;
  tc text;
begin
  tc := case when g.base_ms is null then '-' else
    concat(g.base_ms / 1000, '+', g.inc_ms / 1000,
      case when g.delay_ms > 0 then concat(' d', g.delay_ms / 1000) end,
      case when g.tl_delay_ms > 0 then concat(' tl', g.tl_delay_ms / 1000) end) end;
  head := concat_ws(E'\n',
    format('[Event "%s"]', case when g.engine_color is not null then 'Casual game against Kairos' else 'Casual online game' end),
    format('[Site "https://fireplank.github.io/5d-chess-lab/#/game/%s"]', g.id),
    format('[GameId "%s"]', g.id),
    format('[Date "%s"]', to_char(g.created_at at time zone 'utc', 'YYYY.MM.DD')),
    format('[UTCTime "%s"]', to_char(g.created_at at time zone 'utc', 'HH24:MI:SS')),
    format('[White "%s"]', private.name_of(g, 1::smallint)),
    format('[Black "%s"]', private.name_of(g, 2::smallint)),
    format('[TimeControl "%s"]', tc),
    format('[Result "%s"]', g.result),
    format('[Termination "%s"]', private.termination_text(g)),
    btrim(g.setup, E'\n'));
  for m in select value from jsonb_array_elements(g.moves) loop
    body := body || case when i % 2 = 0 then case when i = 0 then '' else E'\n' end || (i / 2 + 1)::text || '. ' else ' / ' end
      || coalesce(m->>'full', m->>'san', m->>'lan')
      || case when m->>'clk' is not null then format(' {[%%clk %s]}', private.clk((m->>'clk')::bigint)) else '' end;
    i := i + 1;
  end loop;
  if g.result <> '*' then body := body || ' ' || g.result; end if;
  return head || E'\n\n' || body || E'\n';
end $$;

/** Write the finished game's permanent rows (none for a game with no moves). */
create function private.log_game(g public.live_games) returns void language plpgsql as $$
declare
  side smallint;
  score real;
begin
  if g.ply = 0 or exists (select 1 from public.games where id = g.id) then return; end if;
  insert into public.games (id, created_at, ended_at, variant, position, base_ms, inc_ms, delay_ms, tl_delay_ms,
    private, result, termination, move_count, duration_ms, white_name, black_name, moves, record)
  values (g.id, g.created_at, g.ended_at, g.variant, g.position, g.base_ms, g.inc_ms, g.delay_ms, g.tl_delay_ms,
    g.private, g.result, g.termination, g.ply, private.ms(g.ended_at - g.created_at),
    private.name_of(g, 1::smallint), private.name_of(g, 2::smallint), g.moves, private.record(g));
  foreach side in array array[1, 2]::smallint[] loop
    score := case g.result when '1-0' then case side when 1 then 1 else 0 end
      when '0-1' then case side when 2 then 1 else 0 end when '1/2-1/2' then 0.5 end;
    if g.engine_color = side then
      insert into public.engine_games (game_id, color, score, clock_at_end_ms, engine, engine_version, strength_level)
      values (g.id, side, score, private.time_left(g, side, g.ended_at), g.engine, g.engine_version, g.engine_level);
    elsif private.player_of(g, side) is not null then
      insert into public.player_games (game_id, color, player, score, clock_at_end_ms)
      values (g.id, side, private.player_of(g, side), score, private.time_left(g, side, g.ended_at));
    end if;
  end loop;
end $$;

/**
 * End game `gid`: freeze the clocks, close the draw offer and every disconnect window, release the
 * players (they may play again at once), and log it. `winner` 1, 2, or null (draw, or with
 * `aborted` no result).
 */
create function private.conclude(gid text, p_winner smallint, p_termination text) returns void language plpgsql as $$
declare
  g public.live_games;
  now_ timestamptz := clock_timestamp();
begin
  select * into g from public.live_games where id = gid for update;
  if g.id is null or g.result is not null then return; end if;
  if g.color_ticking is not null then
    if g.color_ticking = 1 then g.white_ms := greatest(0, private.time_left(g, 1::smallint, now_));
    else g.black_ms := greatest(0, private.time_left(g, 2::smallint, now_)); end if;
  end if;
  update public.live_games set
    white_ms = g.white_ms, black_ms = g.black_ms, color_ticking = null, turn_started_at = now_,
    draw_offer = null, white_claim_at = null, black_claim_at = null, white_claim_voluntary = null,
    black_claim_voluntary = null, empty_since = null, engine_frozen = false,
    result = case when p_termination = 'aborted' then '*' when p_winner = 1 then '1-0' when p_winner = 2 then '0-1' else '1/2-1/2' end,
    termination = p_termination, ended_at = now_, updated_at = now_
  where id = gid returning * into g;
  delete from public.active_players where game_id = gid;
  perform private.log_game(g);
end $$;

-- ---------------------------------------------------------------------------------- the game clock

/**
 * The clock after `mover` played an action at `at` (the action that makes the game `ply` long):
 * no clock before both sides have moved; at ply 2 the side to move starts with its full time
 * and no increment; from ply 3 the mover is charged (past the turn's delay) and gains the
 * increment. Returns the mover's time after the action (for [%clk]), or null.
 */
create function private.clock_after_move(gid text, mover smallint, p_ply integer, p_next smallint, p_active integer, p_at timestamptz)
returns bigint language plpgsql as $$
declare
  g public.live_games;
  left_ bigint;
begin
  select * into g from public.live_games where id = gid;
  if g.base_ms is null then
    update public.live_games set active_timelines = p_active where id = gid;
    return null;
  end if;
  if p_ply >= 3 and g.color_ticking = mover then
    left_ := private.time_left(g, mover, p_at) + g.inc_ms;
  else
    left_ := case mover when 1 then g.white_ms else g.black_ms end;
  end if;
  update public.live_games set
    white_ms = case mover when 1 then left_ else white_ms end,
    black_ms = case mover when 2 then left_ else black_ms end,
    color_ticking = case when p_ply >= 2 then p_next end,
    turn_started_at = p_at,
    active_timelines = p_active,
    turn_delay_ms = g.delay_ms + g.tl_delay_ms * p_active
  where id = gid;
  return left_;
end $$;

-- ---------------------------------------------------------------------------------- the evaluator

/**
 * Bring game `gid` up to date with the time: a flag fall, a player gone (the reconnect cushion,
 * then the opponent's claim window), every person gone (abandonment), and after the game, players
 * leaving (rematch offers withdrawn; the live row goes once both have left). Run on every ping,
 * every action, and by the sweep.
 */
create function private.evaluate(gid text) returns void language plpgsql as $$
declare
  g public.live_games;
  now_ timestamptz := clock_timestamp();
  side smallint;
  pr private.presence;
  gone_at timestamptz;
  voluntary boolean;
  claim timestamptz;
  everyone_gone boolean := true;
  humans integer := 0;
begin
  select * into g from public.live_games where id = gid for update;
  if g.id is null then return; end if;

  if g.result is null then
    -- Flag fall.
    if g.color_ticking is not null and private.time_left(g, g.color_ticking, now_) <= 0 then
      perform private.conclude(gid, (3 - g.color_ticking)::smallint, 'time');
      return;
    end if;

    foreach side in array array[1, 2]::smallint[] loop
      if private.player_of(g, side) is null then continue; end if; -- Kairos's side
      humans := humans + 1;
      if private.connected(g, side) then
        everyone_gone := false;
        continue;
      end if;
      -- Against Kairos nobody can claim: only the 5-minute abandonment applies.
      if g.engine_color is not null then continue; end if;
      -- Gone: when, and on purpose (the page closed) or not (no pings).
      select * into pr from private.presence p
        where p.player = private.player_of(g, side) and p.page = 'game' and p.ref = gid
          and p.tab = case side when 1 then g.white_tab else g.black_tab end;
      if pr.player is null then
        gone_at := g.created_at; voluntary := false;               -- never arrived
      elsif pr.left_at is not null then
        gone_at := pr.left_at; voluntary := true;
      else
        gone_at := pr.seen_at + private.c('stale'); voluntary := false;
      end if;
      claim := case side when 1 then g.white_claim_at else g.black_claim_at end;
      if claim is null then
        if voluntary then
          claim := gone_at + private.c('claim_voluntary');
        elsif now_ >= gone_at + private.c('cushion') then
          claim := gone_at + private.c('cushion') + private.c('claim_involuntary');
        end if;
        if claim is not null then
          if side = 1 then update public.live_games set white_claim_at = claim, white_claim_voluntary = voluntary, updated_at = now_ where id = gid;
          else update public.live_games set black_claim_at = claim, black_claim_voluntary = voluntary, updated_at = now_ where id = gid; end if;
          perform private.notice(gid, side, case when voluntary then 'disconnect-voluntary' else 'disconnect-involuntary' end);
        end if;
      end if;
    end loop;

    -- Every person gone: after 5 minutes the game ends (aborted under 2 plies; Kairos wins a game
    -- against it; else a draw by abandonment).
    if humans > 0 and everyone_gone then
      if g.empty_since is null then
        update public.live_games set empty_since = now_ where id = gid;
      elsif now_ >= g.empty_since + private.c('abandonment') then
        if g.ply <= 1 then perform private.conclude(gid, null, 'aborted');
        elsif g.engine_color is not null then perform private.conclude(gid, g.engine_color, 'disconnect');
        else perform private.conclude(gid, null, 'abandonment'); end if;
      end if;
    elsif g.empty_since is not null then
      update public.live_games set empty_since = null where id = gid;
    end if;
    return;
  end if;

  -- After the game: a player whose page is gone has left (and withdraws a rematch offer); once
  -- both have left the live row goes (the finished game is in `games`).
  everyone_gone := true;
  foreach side in array array[1, 2]::smallint[] loop
    if private.player_of(g, side) is null then continue; end if;
    if private.connected(g, side) then
      everyone_gone := false;
      if (side = 1 and g.white_gone) or (side = 2 and g.black_gone) then
        if side = 1 then update public.live_games set white_gone = false, updated_at = now_ where id = gid;
        else update public.live_games set black_gone = false, updated_at = now_ where id = gid; end if;
        if g.engine_color is null then perform private.notice(gid, side, 'postgame-returned'); end if;
      end if;
    else
      select * into pr from private.presence p
        where p.player = private.player_of(g, side) and p.page = 'game' and p.ref = gid
          and p.tab = case side when 1 then g.white_tab else g.black_tab end;
      if pr.player is not null and pr.left_at is null and now_ < pr.seen_at + private.c('stale') + private.c('cushion') then
        everyone_gone := false; -- within the reconnect cushion
        continue;
      end if;
      if (side = 1 and not g.white_gone) or (side = 2 and not g.black_gone) then
        if side = 1 then update public.live_games set white_gone = true, white_rematch = false, updated_at = now_ where id = gid;
        else update public.live_games set black_gone = true, black_rematch = false, updated_at = now_ where id = gid; end if;
        if g.engine_color is null then perform private.notice(gid, side, 'postgame-left'); end if;
      end if;
    end if;
  end loop;
  if everyone_gone then
    delete from private.chat_entries where game_id = gid;
    delete from public.live_games where id = gid;
  end if;
end $$;

/** Reconnect side effects for `side` coming back to game g (from game_open or a ping). */
create function private.returned(gid text, side smallint) returns void language plpgsql as $$
declare
  g public.live_games;
  had_claim boolean;
begin
  select * into g from public.live_games where id = gid for update;
  if g.id is null or g.result is not null then return; end if;
  had_claim := case side when 1 then g.white_claim_at is not null else g.black_claim_at is not null end;
  update public.live_games set
    white_claim_at = case side when 1 then null else white_claim_at end,
    white_claim_voluntary = case side when 1 then null else white_claim_voluntary end,
    black_claim_at = case side when 2 then null else black_claim_at end,
    black_claim_voluntary = case side when 2 then null else black_claim_voluntary end,
    empty_since = null,
    -- Kairos's clock, frozen while its player was away on Kairos's turn, runs again from the
    -- time it had when its turn began (its search starts afresh).
    color_ticking = case when engine_frozen then engine_color else color_ticking end,
    turn_started_at = case when engine_frozen then clock_timestamp() else turn_started_at end,
    engine_frozen = false,
    updated_at = clock_timestamp()
  where id = gid;
  if had_claim then perform private.notice(gid, side, 'reconnected'); end if;
end $$;

/** Stop Kairos's clock (rewound to its turn's start) while its player is away on its turn. */
create function private.freeze_engine(gid text) returns void language plpgsql as $$
begin
  update public.live_games set engine_frozen = true, color_ticking = null, updated_at = clock_timestamp()
  where id = gid and result is null and engine_color is not null and color_ticking = engine_color;
end $$;

-- ---------------------------------------------------------------------------------- seeks and the lobby

/**
 * Create a seek (public, or a private challenge) for the player: replaces any seek they had.
 * Called by the `game` edge function, which has checked the position and time control.
 */
create function public.seek_create(p_token text, p_tab text, p_private boolean, p_variant text, p_position text,
  p_setup text, p_start_to_move smallint, p_start_active integer, p_base_ms integer, p_inc_ms integer,
  p_delay_ms integer, p_tl_delay_ms integer, p_color smallint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  id text;
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  perform private.flood(p);
  delete from public.seeks s where s.owner = p;
  id := private.new_id();
  insert into public.seeks (id, owner, owner_tab, private, variant, position, setup, start_to_move, start_active,
    base_ms, inc_ms, delay_ms, tl_delay_ms, color, owner_away_since)
  values (id, p, p_tab, p_private, p_variant, p_position, p_setup, p_start_to_move, p_start_active,
    p_base_ms, coalesce(p_inc_ms, 0), coalesce(p_delay_ms, 0), coalesce(p_tl_delay_ms, 0), p_color,
    case when p_private then clock_timestamp() end);
  -- A public seek lives while its owner is in the lobby.
  if not p_private then
    insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, 'lobby', null, clock_timestamp())
      on conflict (player, tab) do update set page = 'lobby', ref = null, seen_at = excluded.seen_at, left_at = null;
  end if;
  return jsonb_build_object('id', id);
end $$;

create function public.seek_cancel(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.seeks s where s.id = p_id and s.owner = private.pid(p_token);
end $$;

/** Start a game from seek `sk` (claimed and deleted by the caller) between its owner and `acceptor`. */
create function private.start_game(sk public.seeks, acceptor text, acceptor_tab text) returns text
language plpgsql as $$
declare
  owner_color smallint := coalesce(sk.color, (1 + floor(random() * 2))::smallint);
begin
  delete from public.seeks s where s.owner in (sk.owner, acceptor);
  -- Leave any finished game still open for a rematch.
  update public.live_games set white_gone = true, white_rematch = false where white in (sk.owner, acceptor) and result is not null;
  update public.live_games set black_gone = true, black_rematch = false where black in (sk.owner, acceptor) and result is not null;
  insert into public.live_games (id, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms,
    tl_delay_ms, white, black, white_tab, black_tab, to_move, white_ms, black_ms, active_timelines, turn_delay_ms)
  values (sk.id, sk.variant, sk.position, sk.setup, sk.start_to_move, sk.start_active, sk.private, sk.base_ms, sk.inc_ms, sk.delay_ms,
    sk.tl_delay_ms,
    case owner_color when 1 then sk.owner else acceptor end,
    case owner_color when 2 then sk.owner else acceptor end,
    case owner_color when 1 then sk.owner_tab else acceptor_tab end,
    case owner_color when 2 then sk.owner_tab else acceptor_tab end,
    sk.start_to_move, sk.base_ms, sk.base_ms, sk.start_active, sk.delay_ms + sk.tl_delay_ms * sk.start_active);
  insert into public.active_players (player, game_id, role, navigate_tab) values
    (sk.owner, sk.id, owner_color, sk.owner_tab),
    (acceptor, sk.id, 3 - owner_color, acceptor_tab);
  -- A private challenge's owner who closed its page on purpose is counted gone from the start.
  if sk.private and sk.owner_left_voluntarily and sk.owner_away_since is not null then
    insert into private.presence (player, tab, page, ref, seen_at, left_at)
    values (sk.owner, sk.owner_tab, 'game', sk.id, sk.owner_away_since, sk.owner_away_since)
    on conflict (player, tab) do update set page = 'game', ref = sk.id, seen_at = excluded.seen_at, left_at = excluded.left_at;
  end if;
  return sk.id;
end $$;

/** Accept a seek (public or a private challenge). Returns the game id and your side. */
create function public.seek_accept(p_token text, p_tab text, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  sk public.seeks;
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  select * into sk from public.seeks s where s.id = p_id for update;
  if sk.id is null then raise exception 'Game aborted.' using errcode = 'P0001'; end if;
  if sk.owner = p then return jsonb_build_object('ignored', true); end if;
  delete from public.seeks s where s.id = p_id;
  perform private.start_game(sk, p, p_tab);
  return jsonb_build_object('id', sk.id, 'role', (select role from public.active_players a where a.player = p));
end $$;

-- ---------------------------------------------------------------------------------- presence

/**
 * A page of the player is alive (every 5 s): the lobby, a challenge page (its id), or a game (its
 * id). Returns the server time (clients align their clocks with it) and, for a game page, whether
 * another tab has taken the game over.
 */
create function public.ping(p_token text, p_tab text, p_page text, p_ref text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  g public.live_games;
  side smallint;
  superseded boolean := false;
begin
  perform private.check_tab(p_tab);
  if p_page not in ('lobby', 'challenge', 'game') then raise exception 'bad page' using errcode = '22023'; end if;
  insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, p_page, p_ref, clock_timestamp())
    on conflict (player, tab) do update set page = excluded.page, ref = excluded.ref, seen_at = excluded.seen_at, left_at = null;
  if p_page = 'challenge' then
    update public.seeks s set owner_away_since = null, owner_left_voluntarily = false where s.id = p_ref and s.owner = p;
  elsif p_page = 'game' then
    select * into g from public.live_games where id = p_ref;
    if g.id is not null then
      side := private.side(g, p);
      if side is not null then
        superseded := (case side when 1 then g.white_tab else g.black_tab end) is distinct from p_tab;
        if not superseded and (case side when 1 then g.white_claim_at else g.black_claim_at end) is not null then
          perform private.returned(g.id, side);
        end if;
      end if;
      perform private.evaluate(g.id);
      -- Evaluate the opponent's game too when they are gone (their pings stopped).
    end if;
  end if;
  return jsonb_build_object('now', private.ms(clock_timestamp() - 'epoch'::timestamptz), 'superseded', superseded);
end $$;

/** A page closed on purpose (pagehide, or leaving it within the site). */
create function public.leave(p_token text, p_tab text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  pr private.presence;
  g public.live_games;
begin
  update private.presence set left_at = clock_timestamp() where player = p and tab = p_tab returning * into pr;
  if pr.player is null then return; end if;
  if pr.page = 'lobby' then
    -- Leaving the lobby takes the public seek away, unless another lobby tab of the player is open.
    if not exists (select 1 from private.presence o where o.player = p and o.tab <> p_tab and o.page = 'lobby'
        and o.left_at is null and o.seen_at > clock_timestamp() - private.c('stale')) then
      delete from public.seeks s where s.owner = p and not s.private;
    end if;
  elsif pr.page = 'challenge' then
    if not exists (select 1 from private.presence o where o.player = p and o.tab <> p_tab and o.page = 'challenge'
        and o.ref = pr.ref and o.left_at is null and o.seen_at > clock_timestamp() - private.c('stale')) then
      update public.seeks s set owner_away_since = clock_timestamp(), owner_left_voluntarily = true
      where s.id = pr.ref and s.owner = p;
    end if;
  elsif pr.page = 'game' then
    select * into g from public.live_games where id = pr.ref;
    if g.id is not null and private.side(g, p) is not null
        and (case private.side(g, p) when 1 then g.white_tab else g.black_tab end) = p_tab then
      if g.engine_color is not null then perform private.freeze_engine(g.id); end if;
      perform private.evaluate(g.id);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------------- challenges

/**
 * Open a challenge link: {kind: 'open', owner, seek, ingame?} while it waits (its owner counts
 * as present), {kind: 'game', role?} once it became a game, else {kind: 'gone'}.
 */
create function public.challenge_open(p_token text, p_tab text, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  sk public.seeks;
  a public.active_players;
begin
  perform private.check_tab(p_tab);
  select * into sk from public.seeks s where s.id = p_id;
  if sk.id is not null then
    insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, 'challenge', p_id, clock_timestamp())
      on conflict (player, tab) do update set page = 'challenge', ref = p_id, seen_at = excluded.seen_at, left_at = null;
    if sk.owner = p then
      update public.seeks s set owner_away_since = null, owner_left_voluntarily = false where s.id = p_id;
    end if;
    select * into a from public.active_players x where x.player = p;
    return jsonb_build_object('kind', 'open', 'owner', sk.owner = p,
      'seek', jsonb_build_object('id', sk.id, 'private', sk.private, 'variant', sk.variant, 'position', sk.position,
        'base_ms', sk.base_ms, 'inc_ms', sk.inc_ms, 'delay_ms', sk.delay_ms, 'tl_delay_ms', sk.tl_delay_ms,
        'color', sk.color, 'created_at', sk.created_at),
      'ingame', case when a.player is not null then jsonb_build_object('id', a.game_id, 'role', a.role) end);
  end if;
  if exists (select 1 from public.live_games g where g.id = p_id) or exists (select 1 from public.games g where g.id = p_id) then
    select * into a from public.active_players x where x.player = p and x.game_id = p_id;
    return jsonb_build_object('kind', 'game', 'role', a.role);
  end if;
  return jsonb_build_object('kind', 'gone');
end $$;

-- ---------------------------------------------------------------------------------- engine games

/**
 * A game against Kairos (it runs in the player's browser, which also sends its actions). The
 * edge function has checked the position, time control and level.
 */
create function public.engine_game_create(p_token text, p_tab text, p_variant text, p_position text, p_setup text,
  p_start_to_move smallint, p_start_active integer, p_base_ms integer, p_inc_ms integer, p_delay_ms integer,
  p_tl_delay_ms integer, p_color smallint, p_level smallint, p_version text, p_book boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  id text := private.new_id();
  human smallint := coalesce(p_color, (1 + floor(random() * 2))::smallint);
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  perform private.flood(p);
  delete from public.seeks s where s.owner = p;
  update public.live_games set white_gone = true, white_rematch = false where white = p and result is not null;
  update public.live_games set black_gone = true, black_rematch = false where black = p and result is not null;
  insert into public.live_games (id, variant, position, setup, start_to_move, start_active, base_ms, inc_ms, delay_ms, tl_delay_ms,
    white, black, white_tab, black_tab, engine_color, engine, engine_version, engine_level, engine_book,
    to_move, white_ms, black_ms, active_timelines, turn_delay_ms)
  values (id, p_variant, p_position, p_setup, p_start_to_move, p_start_active, p_base_ms, coalesce(p_inc_ms, 0), coalesce(p_delay_ms, 0),
    coalesce(p_tl_delay_ms, 0),
    case human when 1 then p end, case human when 2 then p end,
    case human when 1 then p_tab end, case human when 2 then p_tab end,
    3 - human, 'kairos', left(coalesce(p_version, 'unknown'), 40), greatest(1, least(8, p_level)), coalesce(p_book, true),
    p_start_to_move, p_base_ms, p_base_ms, p_start_active, coalesce(p_delay_ms, 0) + coalesce(p_tl_delay_ms, 0) * p_start_active);
  insert into public.active_players (player, game_id, role, navigate_tab) values (p, id, human, p_tab);
  return jsonb_build_object('id', id, 'role', human);
end $$;

-- ---------------------------------------------------------------------------------- moves

/**
 * Apply an action the edge function has checked: `p_ply` is the game's length before it (a stale
 * or out-of-turn submission returns the game as it is, for the client to resync). `p_status` is
 * the rules core's verdict after the action (checkmate | stalemate | exiled-white | exiled-black).
 */
create function public.game_apply_move(p_token text, p_tab text, p_id text, p_ply integer, p_lan text, p_san text,
  p_full text, p_lone boolean, p_next_to_move smallint, p_active integer, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  g public.live_games;
  mover smallint;
  side smallint;
  now_ timestamptz := clock_timestamp();
  clk bigint;
begin
  perform private.evaluate(p_id); -- a flag that fell before this action ends the game first
  select * into g from public.live_games where id = p_id for update;
  if g.id is null then return jsonb_build_object('error', 'gone'); end if;
  if g.result is not null then return jsonb_build_object('error', 'over'); end if;
  side := private.side(g, p);
  if side is null then return jsonb_build_object('error', 'not a player'); end if;
  -- Against Kairos the player's browser plays both sides.
  mover := case when g.engine_color is not null then g.to_move else side end;
  if mover <> g.to_move or p_ply <> g.ply then return jsonb_build_object('error', 'resync'); end if;
  update public.live_games set
    moves = moves || jsonb_build_array(jsonb_build_object('lan', p_lan, 'san', p_san, 'full', p_full, 'lone', p_lone)),
    ply = ply + 1, to_move = p_next_to_move,
    -- A move declines the opponent's open draw offer.
    draw_offer = case when draw_offer = 3 - mover then null else draw_offer end,
    updated_at = now_
  where id = p_id;
  clk := private.clock_after_move(p_id, mover, g.ply + 1, p_next_to_move, p_active, now_);
  if clk is not null then
    update public.live_games set moves = jsonb_set(moves, array[(jsonb_array_length(moves) - 1)::text, 'clk'], to_jsonb(clk))
    where id = p_id;
  end if;
  if p_status = 'checkmate' then perform private.conclude(p_id, mover, 'checkmate');
  elsif p_status = 'exiled-white' then perform private.conclude(p_id, 2::smallint, 'exiled');
  elsif p_status = 'exiled-black' then perform private.conclude(p_id, 1::smallint, 'exiled');
  elsif p_status = 'stalemate' then perform private.conclude(p_id, null, 'stalemate');
  end if;
  return jsonb_build_object('ok', true, 'ply', g.ply + 1);
end $$;

-- ---------------------------------------------------------------------------------- game actions

/**
 * Open a game page: the game (live or finished) and, for one of its players, their side; the
 * tab takes the game over from any other tab of theirs, and a player who was away is back.
 */
create function public.game_open(p_token text, p_tab text, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  g public.live_games;
  side smallint;
begin
  perform private.check_tab(p_tab);
  select * into g from public.live_games where id = p_id;
  if g.id is null then
    if exists (select 1 from public.games x where x.id = p_id) then
      return jsonb_build_object('live', false, 'game', (select to_jsonb(x) from public.games x where x.id = p_id),
        'role', (select color from public.player_games pg where pg.game_id = p_id and pg.player = p limit 1));
    end if;
    return jsonb_build_object('live', false, 'game', null);
  end if;
  side := private.side(g, p);
  if side is not null then
    -- Another tab taking over a game against Kairos on Kairos's turn restarts its search there,
    -- so its clock goes back to its turn's start (as when its player leaves and comes back).
    if g.engine_color is not null and g.result is null and (case side when 1 then g.white_tab else g.black_tab end) is distinct from p_tab then
      perform private.freeze_engine(p_id);
    end if;
    update public.live_games set
      white_tab = case side when 1 then p_tab else white_tab end,
      black_tab = case side when 2 then p_tab else black_tab end
    where id = p_id;
    insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, 'game', p_id, clock_timestamp())
      on conflict (player, tab) do update set page = 'game', ref = p_id, seen_at = excluded.seen_at, left_at = null;
    update public.active_players set navigate_tab = null where player = p and game_id = p_id;
    perform private.returned(p_id, side);
    perform private.evaluate(p_id);
  end if;
  select * into g from public.live_games where id = p_id;
  return jsonb_build_object('live', g.id is not null, 'game', to_jsonb(g), 'role', side,
    'now', private.ms(clock_timestamp() - 'epoch'::timestamptz));
end $$;

/** Run the timers of a game now (a client whose display shows a clock at zero asks). */
create function public.game_check(p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.evaluate(p_id);
end $$;

/** Lock game p_id for one of its players; throws for anyone else. */
create function private.lock_game(p_id text) returns public.live_games language plpgsql as $$
declare g public.live_games;
begin
  select * into g from public.live_games where id = p_id for update;
  if g.id is null then raise exception 'Game not found.' using errcode = 'P0001'; end if;
  return g;
end $$;

create function private.my_side(g public.live_games, p_token text) returns smallint language plpgsql as $$
declare side smallint := private.side(g, private.pid(p_token));
begin
  if side is null then raise exception 'You are not playing this game.' using errcode = 'P0001'; end if;
  return side;
end $$;

/** Resign (from ply 2 on). */
create function public.game_resign(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is not null or g.ply <= 1 then return; end if;
  perform private.conclude(p_id, (3 - side)::smallint, 'resignation');
end $$;

/** Abort (before both sides have moved; leniently also right after the second action). */
create function public.game_abort(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is not null or g.ply > 2 then return; end if;
  perform private.conclude(p_id, null, 'aborted');
end $$;

/** Kairos gives up (its search found no action, or it failed): it resigns, or aborts before 2 plies. */
create function public.engine_resign(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is not null or g.engine_color is null then return; end if;
  if g.ply <= 1 then perform private.conclude(p_id, null, 'aborted');
  else perform private.conclude(p_id, side, 'resignation'); end if;
end $$;

/** Offer a draw: not against Kairos, not before 2 plies, not with an offer open, and 2 plies after your last. */
create function public.game_offer_draw(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint; last_ integer;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  last_ := case side when 1 then g.white_last_offer_ply else g.black_last_offer_ply end;
  if g.result is not null or g.engine_color is not null or g.draw_offer is not null or g.ply <= 1
     or (last_ is not null and g.ply - last_ < 2) then return; end if;
  update public.live_games set draw_offer = side,
    white_last_offer_ply = case side when 1 then g.ply else white_last_offer_ply end,
    black_last_offer_ply = case side when 2 then g.ply else black_last_offer_ply end,
    updated_at = clock_timestamp()
  where id = p_id;
  perform private.notice(p_id, side, 'draw-offered');
end $$;

create function public.game_answer_draw(p_token text, p_id text, p_accept boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is not null or g.draw_offer is distinct from 3 - side then return; end if;
  if p_accept then
    perform private.notice(p_id, side, 'draw-accepted');
    perform private.conclude(p_id, null, 'agreement');
  else
    update public.live_games set draw_offer = null, updated_at = clock_timestamp() where id = p_id;
    perform private.notice(p_id, side, 'draw-declined');
  end if;
end $$;

/** Claim the win (or a draw) once a gone opponent's claim window has opened, from ply 2 on. */
create function public.game_claim(p_token text, p_id text, p_draw boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint; claim timestamptz;
begin
  perform private.evaluate(p_id);
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  claim := case side when 1 then g.black_claim_at else g.white_claim_at end;
  if g.result is not null or g.ply <= 1 or claim is null or clock_timestamp() < claim then return; end if;
  if p_draw then perform private.conclude(p_id, null, 'abandonment');
  else perform private.conclude(p_id, side, 'disconnect'); end if;
end $$;

/**
 * Offer a rematch once the game is over (against Kairos it starts at once): when both have
 * offered, the rematch starts with the sides swapped; both pages follow `rematch_id`.
 */
create function public.game_rematch(p_token text, p_tab text, p_id text, p_version text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  g public.live_games; side smallint; nid text;
  p text := private.pid(p_token);
begin
  perform private.check_tab(p_tab);
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is null or g.rematch_id is not null then return jsonb_build_object('id', g.rematch_id); end if;
  if g.engine_color is null then
    if (side = 1 and g.white_rematch) or (side = 2 and g.black_rematch) then return jsonb_build_object('waiting', true); end if;
    if not ((side = 1 and g.black_rematch) or (side = 2 and g.white_rematch)) then
      update public.live_games set white_rematch = white_rematch or side = 1, black_rematch = black_rematch or side = 2,
        updated_at = clock_timestamp() where id = p_id;
      perform private.notice(p_id, side, 'rematch-offered');
      return jsonb_build_object('waiting', true);
    end if;
    perform private.notice(p_id, side, 'rematch-accepted');
  end if;
  if exists (select 1 from public.active_players a where a.player in (g.white, g.black)) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  nid := private.new_id();
  insert into public.live_games (id, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms,
    tl_delay_ms, white, black, white_tab, black_tab, engine_color, engine, engine_version, engine_level, engine_book,
    to_move, white_ms, black_ms, active_timelines, turn_delay_ms)
  select nid, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms, tl_delay_ms,
    black, white, black_tab, white_tab, case when engine_color is not null then 3 - engine_color end, engine,
    coalesce(left(p_version, 40), engine_version), engine_level, engine_book,
    start_to_move, base_ms, base_ms, start_active, delay_ms + tl_delay_ms * start_active
  from public.live_games where id = p_id;
  insert into public.active_players (player, game_id, role, navigate_tab)
  select x.player, nid, x.role, x.tab from (values (g.black, 1::smallint, g.black_tab), (g.white, 2::smallint, g.white_tab)) as x(player, role, tab)
  where x.player is not null;
  update public.live_games set rematch_id = nid, updated_at = clock_timestamp() where id = p_id;
  return jsonb_build_object('id', nid, 'role', 3 - side);
end $$;

-- ---------------------------------------------------------------------------------- chat

/** The chat log of a game, from line `p_since`, for its players only. */
create function public.game_chat(p_token text, p_id text, p_since integer default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; p text := private.pid(p_token);
begin
  select * into g from public.live_games where id = p_id;
  if g.id is null or private.side(g, p) is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('idx', c.idx, 'player', c.player, 'message', c.message,
      'notice', c.notice, 'ago', private.ms(clock_timestamp() - c.sent_at)) order by c.idx)
    from private.chat_entries c where c.game_id = p_id and c.idx >= coalesce(p_since, 0)), '[]'::jsonb);
end $$;

/**
 * Say something in a game's chat: not against Kairos, and (everyone being a guest) only in a
 * private game; at most 140 characters, no control characters, 5 messages per 10 s, and never
 * the same as either of your last two.
 */
create function public.game_say(p_token text, p_id text, p_text text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint; t text := btrim(coalesce(p_text, ''));
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.engine_color is not null or not g.private then raise exception 'Chat is only for private games.' using errcode = 'P0001'; end if;
  if t = '' or length(t) > 140 or t ~ '[\x00-\x08\x0A-\x1F\x7F]' then raise exception 'That message cannot be sent.' using errcode = 'P0001'; end if;
  if (select count(*) from private.chat_entries c where c.game_id = p_id and c.player = side and c.message is not null
      and c.sent_at > clock_timestamp() - interval '10 seconds') >= 5 then
    raise exception 'Slow down, too many messages.' using errcode = 'P0001';
  end if;
  if exists (select 1 from (select c.message from private.chat_entries c where c.game_id = p_id and c.player = side
      and c.message is not null order by c.idx desc limit 2) last2 where last2.message = t) then
    raise exception 'You just said that.' using errcode = 'P0001';
  end if;
  perform private.notice(p_id, side, null, t);
end $$;

-- ---------------------------------------------------------------------------------- the sweep

/**
 * Every few seconds (pg_cron): run every live game's timers, drop public seeks whose owner left
 * the lobby (5 s after their pings stopped) and challenges whose owner has been away 10 minutes,
 * and forget old presence.
 */
create function private.sweep() returns void language plpgsql as $$
declare gid text;
begin
  for gid in select id from public.live_games loop
    perform private.evaluate(gid);
  end loop;
  delete from public.seeks s where not s.private and not exists (
    select 1 from private.presence pr where pr.player = s.owner and pr.page = 'lobby' and pr.left_at is null
      and pr.seen_at > clock_timestamp() - private.c('stale') - private.c('cushion'))
    and s.created_at < clock_timestamp() - private.c('cushion');
  -- A private challenge's owner who stopped pinging its page is away from their last ping on.
  update public.seeks s set owner_away_since = coalesce((select max(pr.seen_at) from private.presence pr
      where pr.player = s.owner and pr.page = 'challenge' and pr.ref = s.id), s.created_at)
  where s.private and s.owner_away_since is null and not exists (
    select 1 from private.presence pr where pr.player = s.owner and pr.page = 'challenge' and pr.ref = s.id
      and pr.left_at is null and pr.seen_at > clock_timestamp() - private.c('stale'));
  delete from public.seeks s where s.private and s.owner_away_since < clock_timestamp() - private.c('challenge_expiry');
  delete from private.presence where seen_at < clock_timestamp() - interval '1 day';
  delete from private.recent where at < clock_timestamp() - interval '1 hour';
end $$;

-- ---------------------------------------------------------------------------------- grants

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.seek_create, public.engine_game_create, public.game_apply_move from public, anon, authenticated;
grant execute on function public.seek_create, public.engine_game_create, public.game_apply_move to service_role;
grant execute on function public.seek_cancel, public.seek_accept, public.ping, public.leave, public.challenge_open,
  public.game_open, public.game_check, public.game_resign, public.game_abort, public.engine_resign,
  public.game_offer_draw, public.game_answer_draw, public.game_claim, public.game_rematch, public.game_chat,
  public.game_say to anon, authenticated;
grant usage on schema private to service_role;

-- The sweep, every 10 seconds (where pg_cron is available: always on Supabase).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron with schema pg_catalog;
    perform cron.schedule('5d-chess-lab-sweep', '10 seconds', 'select private.sweep()');
  end if;
end $$;
