-- Accounts and rated games. Players may sign in with Discord or Google (Supabase Auth); signing
-- in links the browser's player token to the account (account_link), so every existing call keeps
-- working by player id and finds the account behind it. An account has a profile: a display name
-- and one Glicko-2 rating, as lichess rates (tau 0.75, from 1500 ± 500 with volatility 0.09,
-- deviations within 45..500, volatility at most 0.1, ratings within 400..4000, at most 700
-- points a game, provisional from a deviation of 110, the deviation growing back at 0.21436
-- rating periods a day while the player is away; shown truncated, as lichess's intRating). A player whose
-- Discord id is in the imported 5D rating list (private.rating_import) starts from that rating.
--
-- A rated game is between two signed-in people (never two sessions of one account, and never
-- against Kairos), timed, in a rated variant. When it ends (not aborted) both ratings change; the
-- live game, the record and player_games keep the ratings going in and the changes.

-- ---------------------------------------------------------------------------------- tables

create table public.profiles (
  user_id uuid primary key,              -- auth.users.id
  name text not null,
  rating real not null default 1500,
  rd real not null default 500,
  vol real not null default 0.09,
  games integer not null default 0,      -- rated games played
  rated_at timestamptz,                  -- the last rated game (the deviation grows from then)
  imported boolean not null default false,
  created_at timestamptz not null default now()
);

-- Which account a browser's player token belongs to (one account can have many browsers).
create table private.player_users (
  player text primary key,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  linked_at timestamptz not null default now()
);
create index player_users_user on private.player_users (user_id);

-- The 5D community's ratings, by Discord user id (loaded by hand, see scripts/import_ratings.py).
-- A Discord account found here starts from this rating at its first sign-in.
create table private.rating_import (
  discord_id text primary key,
  name text,
  rating real not null,
  rd real,                               -- null: from `games` (see private.import_rd)
  vol real,
  games integer,
  claimed_by uuid,
  claimed_at timestamptz
);

alter table public.profiles enable row level security;
alter table private.player_users enable row level security;
alter table private.rating_import enable row level security;
create policy "Profiles are public" on public.profiles for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
grant select on public.profiles to anon, authenticated;

alter table public.seeks
  add column rated boolean not null default false,
  add column owner_name text,
  add column owner_rating integer,
  add column owner_provisional boolean;

alter table public.live_games
  add column rated boolean not null default false,
  add column white_user uuid,
  add column black_user uuid,
  add column white_name text,
  add column black_name text,
  add column white_rating real,          -- going into the game
  add column black_rating real,
  add column white_rd real,
  add column black_rd real,
  add column white_diff integer,         -- the change, once a rated game ends
  add column black_diff integer;

alter table public.games
  add column rated boolean not null default false,
  add column white_user uuid,
  add column black_user uuid,
  add column white_rating real,
  add column black_rating real,
  add column white_rd real,
  add column black_rd real,
  add column white_diff integer,
  add column black_diff integer;

alter table public.player_games
  add column user_id uuid,
  add column rating_before real,
  add column rd_before real,
  add column rating_diff integer;
create index player_games_user on public.player_games (user_id) where user_id is not null;

-- ---------------------------------------------------------------------------------- ratings

/** The variants rated games are played in (one rating for all of them). */
create function private.rated_variant(v text) returns boolean language sql immutable as $$
  select v in ('Standard', 'Standard - Turn Zero')
$$;

/** A rating is provisional while its deviation is 110 or more (lichess's provisionalDeviation). */
create function private.provisional(rd real) returns boolean language sql immutable as $$
  select rd >= 110
$$;

/** A rating as shown: truncated to an integer (lichess's intRating). */
create function private.int_rating(r real) returns integer language sql immutable as $$
  select trunc(r)::integer
$$;

/**
 * The deviation after `days` without rated games: Glicko-2's growth per rating period
 * (sqrt(phi^2 + sigma^2)), at lichess's 0.21436 periods a day, at most 500.
 */
create function private.decayed_rd(rd real, vol real, days double precision) returns real language sql immutable as $$
  select least(500, 173.7178 * sqrt((rd / 173.7178) ^ 2 + greatest(0, days) * 0.21436 * vol ^ 2))::real
$$;

/** The deviation an imported rating starts with when the list gives none: tighter with more games. */
create function private.import_rd(games integer) returns real language sql immutable as $$
  select case when games is null then 150 when games >= 100 then 60 when games >= 30 then 80 when games >= 10 then 110 else 200 end::real
$$;

/** The account a player id is linked to, or null (a guest). */
create function private.user_of(p text) returns uuid language sql stable as $$
  select user_id from private.player_users where player = p
$$;

/** Whether account `u` (any of its browsers) is in a live game or has a seek open (other than `except_seek`). */
create function private.user_busy(u uuid) returns boolean language sql stable as $$
  select u is not null and exists (
    select 1 from public.active_players a join private.player_users pu on pu.player = a.player where pu.user_id = u)
$$;

/** A profile's rating and deviation now (the deviation grown since its last rated game). */
create function private.current_rating(u uuid, out rating real, out rd real, out vol real) language sql stable as $$
  select p.rating, private.decayed_rd(p.rd, p.vol, extract(epoch from (clock_timestamp() - coalesce(p.rated_at, p.created_at))) / 86400), p.vol
  from public.profiles p where p.user_id = u
$$;

/**
 * Rate finished game g (rated, with a result) and return it with the changes: both players'
 * Glicko-2 updates from their ratings now against each other's, at most 700 points each.
 */
create function private.rate_game(g public.live_games) returns public.live_games language plpgsql as $$
declare
  w record; b record; nw record; nb record;
  s real;
begin
  if not g.rated or g.result not in ('1-0', '0-1', '1/2-1/2') or g.white_user is null or g.black_user is null then return g; end if;
  select * into w from private.current_rating(g.white_user);
  select * into b from private.current_rating(g.black_user);
  if w.rating is null or b.rating is null then return g; end if;
  s := case g.result when '1-0' then 1 when '0-1' then 0 else 0.5 end;
  select * into nw from private.glicko(w.rating, w.rd, w.vol, b.rating, b.rd, s, 45, 500);
  select * into nb from private.glicko(b.rating, b.rd, b.vol, w.rating, w.rd, (1 - s)::real, 45, 500);
  -- At most 700 points in one game (lichess's maxRatingDelta).
  nw.new_r := w.rating + greatest(-700, least(700, nw.new_r - w.rating));
  nb.new_r := b.rating + greatest(-700, least(700, nb.new_r - b.rating));
  update public.profiles set rating = nw.new_r, rd = nw.new_rd, vol = nw.new_vol, games = games + 1, rated_at = clock_timestamp()
  where user_id = g.white_user;
  update public.profiles set rating = nb.new_r, rd = nb.new_rd, vol = nb.new_vol, games = games + 1, rated_at = clock_timestamp()
  where user_id = g.black_user;
  update public.live_games set white_diff = private.int_rating(nw.new_r) - private.int_rating(w.rating),
    black_diff = private.int_rating(nb.new_r) - private.int_rating(b.rating)
  where id = g.id returning * into g;
  return g;
end $$;

-- ---------------------------------------------------------------------------------- accounts

/**
 * The signed-in account (Supabase Auth) claims this browser's player token, making its profile
 * on first use: the provider's display name, and the imported rating when its Discord id is in
 * the list. Returns the profile. Call it after every sign-in (and on each visit while signed in).
 */
create function public.account_link(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  u uuid := auth.uid();
  meta jsonb;
  nm text;
  discord text;
  imp private.rating_import;
  prof public.profiles;
begin
  if u is null then raise exception 'Sign in first.' using errcode = 'P0001'; end if;
  select * into prof from public.profiles where user_id = u;
  if prof.user_id is null then
    select raw_user_meta_data into meta from auth.users where id = u;
    nm := left(btrim(coalesce(meta->'custom_claims'->>'global_name', meta->>'full_name', meta->>'name',
      meta->>'user_name', meta->>'preferred_username', 'Player')), 32);
    if nm = '' then nm := 'Player'; end if;
    insert into public.profiles (user_id, name) values (u, nm) returning * into prof;
  end if;
  -- A Discord account in the imported list starts from its rating (once, before any rated game).
  if not prof.imported and prof.games = 0 then
    select provider_id into discord from auth.identities where user_id = u and provider = 'discord' limit 1;
    if discord is not null then
      select * into imp from private.rating_import where discord_id = discord and claimed_by is null for update;
      if imp.discord_id is not null then
        update public.profiles set rating = imp.rating, rd = coalesce(imp.rd, private.import_rd(imp.games)),
          vol = coalesce(imp.vol, 0.09), imported = true, rated_at = clock_timestamp()
        where user_id = u returning * into prof;
        update private.rating_import set claimed_by = u, claimed_at = clock_timestamp() where discord_id = discord;
      end if;
    end if;
  end if;
  insert into private.player_users (player, user_id) values (p, u)
    on conflict (player) do update set user_id = excluded.user_id, linked_at = clock_timestamp();
  return private.profile_json(u);
end $$;

/** A profile for the page: name, rating (rounded, deviation grown since the last game), whether provisional. */
create function private.profile_json(u uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', p.user_id, 'name', p.name, 'rating', private.int_rating(r.rating), 'rd', round(r.rd),
    'provisional', private.provisional(r.rd), 'games', p.games, 'imported', p.imported)
  from public.profiles p, private.current_rating(p.user_id) r where p.user_id = u
$$;

/** The account of this browser's player token (null for a guest). */
create function public.account_me(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := private.user_of(private.pid(p_token));
begin
  if u is null then return null; end if;
  return private.profile_json(u);
end $$;

/** Forget this browser's link (signing out). */
create function public.account_unlink(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from private.player_users where player = private.pid(p_token);
end $$;

-- ---------------------------------------------------------------------------------- names

create or replace function private.name_of(g public.live_games, side smallint) returns text language sql immutable as $$
  select case when g.engine_color = side then
      case when g.engine_level >= 8 then 'Kairos' else format('Kairos (Level %s)', g.engine_level) end
    else coalesce(case side when 1 then g.white_name else g.black_name end, 'Anonymous') end
$$;

/** A side's name, rating and deviation going into a game (a guest: 'Anonymous' and no rating). */
create function private.seat(p text, out user_id uuid, out name text, out rating real, out rd real) language plpgsql stable as $$
begin
  user_id := private.user_of(p);
  if user_id is null then name := null; return; end if;
  select pr.name into name from public.profiles pr where pr.user_id = seat.user_id;
  select r.rating, r.rd into rating, rd from private.current_rating(seat.user_id) r;
end $$;

/** Fill in game gid's players: accounts, names, and their ratings going in. */
create function private.seat_players(gid text) returns void language plpgsql as $$
declare g public.live_games; w record; b record;
begin
  select * into g from public.live_games where id = gid;
  select * into w from private.seat(g.white);
  select * into b from private.seat(g.black);
  update public.live_games set white_user = w.user_id, black_user = b.user_id, white_name = w.name, black_name = b.name,
    white_rating = w.rating, black_rating = b.rating, white_rd = w.rd, black_rd = b.rd
  where id = gid;
end $$;

-- ---------------------------------------------------------------------------------- the record

create or replace function private.record(g public.live_games) returns text language plpgsql stable as $$
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
    format('[Event "%s"]', case when g.engine_color is not null then 'Casual game against Kairos'
      when g.rated then 'Rated online game' else 'Casual online game' end),
    format('[Site "https://fireplank.github.io/5d-chess-lab/#/game/%s"]', g.id),
    format('[GameId "%s"]', g.id),
    format('[Date "%s"]', to_char(g.created_at at time zone 'utc', 'YYYY.MM.DD')),
    format('[UTCTime "%s"]', to_char(g.created_at at time zone 'utc', 'HH24:MI:SS')),
    format('[White "%s"]', replace(private.name_of(g, 1::smallint), '"', '''')),
    format('[Black "%s"]', replace(private.name_of(g, 2::smallint), '"', '''')),
    case when g.rated then format('[WhiteElo "%s"]', private.int_rating(g.white_rating)) end,
    case when g.rated then format('[BlackElo "%s"]', private.int_rating(g.black_rating)) end,
    case when g.rated and g.white_diff is not null then format('[WhiteRatingDiff "%s%s"]', case when g.white_diff > 0 then '+' end, g.white_diff) end,
    case when g.rated and g.black_diff is not null then format('[BlackRatingDiff "%s%s"]', case when g.black_diff > 0 then '+' end, g.black_diff) end,
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

create or replace function private.log_game(g public.live_games) returns void language plpgsql as $$
declare
  side smallint;
  score real;
begin
  if g.ply = 0 or exists (select 1 from public.games where id = g.id) then return; end if;
  insert into public.games (id, created_at, ended_at, variant, position, base_ms, inc_ms, delay_ms, tl_delay_ms,
    private, result, termination, move_count, duration_ms, white_name, black_name, moves, record,
    rated, white_user, black_user, white_rating, black_rating, white_rd, black_rd, white_diff, black_diff)
  values (g.id, g.created_at, g.ended_at, g.variant, g.position, g.base_ms, g.inc_ms, g.delay_ms, g.tl_delay_ms,
    g.private, g.result, g.termination, g.ply, private.ms(g.ended_at - g.created_at),
    private.name_of(g, 1::smallint), private.name_of(g, 2::smallint), g.moves, private.record(g),
    g.rated, g.white_user, g.black_user, g.white_rating, g.black_rating, g.white_rd, g.black_rd, g.white_diff, g.black_diff);
  foreach side in array array[1, 2]::smallint[] loop
    score := case g.result when '1-0' then case side when 1 then 1 else 0 end
      when '0-1' then case side when 2 then 1 else 0 end when '1/2-1/2' then 0.5 end;
    if g.engine_color = side then
      insert into public.engine_games (game_id, color, score, clock_at_end_ms, engine, engine_version, strength_level)
      values (g.id, side, score, private.time_left(g, side, g.ended_at), g.engine, g.engine_version, g.engine_level);
    elsif private.player_of(g, side) is not null then
      insert into public.player_games (game_id, color, player, score, clock_at_end_ms, user_id, rating_before, rd_before, rating_diff)
      values (g.id, side, private.player_of(g, side), score, private.time_left(g, side, g.ended_at),
        case side when 1 then g.white_user else g.black_user end,
        case when g.rated then case side when 1 then g.white_rating else g.black_rating end end,
        case when g.rated then case side when 1 then g.white_rd else g.black_rd end end,
        case side when 1 then g.white_diff else g.black_diff end);
    end if;
  end loop;
end $$;

create or replace function private.conclude(gid text, p_winner smallint, p_termination text) returns void language plpgsql as $$
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
  g := private.rate_game(g);
  perform private.log_game(g);
end $$;

-- ---------------------------------------------------------------------------------- seeks

drop function public.seek_create(text, text, boolean, text, text, text, smallint, integer, integer, integer, integer, integer, smallint);

/**
 * Create a seek (public, or a private challenge) for the player: replaces any seek they had. A
 * rated one needs a signed-in player, a clock and a rated variant. Called by the `game` edge
 * function, which has checked the position and time control.
 */
create function public.seek_create(p_token text, p_tab text, p_private boolean, p_variant text, p_position text,
  p_setup text, p_start_to_move smallint, p_start_active integer, p_base_ms integer, p_inc_ms integer,
  p_delay_ms integer, p_tl_delay_ms integer, p_color smallint, p_rated boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  id text;
  me record;
  rated boolean := coalesce(p_rated, false);
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  select * into me from private.seat(p);
  if private.user_busy(me.user_id) then raise exception 'You are already in a game.' using errcode = 'P0001'; end if;
  if rated then
    if me.user_id is null then raise exception 'Sign in to play rated games.' using errcode = 'P0001'; end if;
    if p_base_ms is null then raise exception 'Rated games need a clock.' using errcode = 'P0001'; end if;
    if not private.rated_variant(p_variant) then
      raise exception 'Rated games are played in Standard and Standard - Turn Zero.' using errcode = 'P0001';
    end if;
  end if;
  perform private.flood(p);
  delete from public.seeks s where s.owner = p;
  id := private.new_id();
  insert into public.seeks (id, owner, owner_tab, private, variant, position, setup, start_to_move, start_active,
    base_ms, inc_ms, delay_ms, tl_delay_ms, color, owner_away_since, rated, owner_name, owner_rating, owner_provisional)
  values (id, p, p_tab, p_private, p_variant, p_position, p_setup, p_start_to_move, p_start_active,
    p_base_ms, coalesce(p_inc_ms, 0), coalesce(p_delay_ms, 0), coalesce(p_tl_delay_ms, 0), p_color,
    case when p_private then clock_timestamp() end, rated, me.name, private.int_rating(me.rating), private.provisional(me.rd));
  if not p_private then
    insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, 'lobby', null, clock_timestamp())
      on conflict (player, tab) do update set page = 'lobby', ref = null, seen_at = excluded.seen_at, left_at = null;
  end if;
  return jsonb_build_object('id', id);
end $$;

create or replace function private.start_game(sk public.seeks, acceptor text, acceptor_tab text) returns text
language plpgsql as $$
declare
  owner_color smallint := coalesce(sk.color, (1 + floor(random() * 2))::smallint);
begin
  delete from public.seeks s where s.owner in (sk.owner, acceptor);
  update public.live_games set white_gone = true, white_rematch = false where white in (sk.owner, acceptor) and result is not null;
  update public.live_games set black_gone = true, black_rematch = false where black in (sk.owner, acceptor) and result is not null;
  insert into public.live_games (id, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms,
    tl_delay_ms, white, black, white_tab, black_tab, to_move, white_ms, black_ms, active_timelines, turn_delay_ms, rated)
  values (sk.id, sk.variant, sk.position, sk.setup, sk.start_to_move, sk.start_active, sk.private, sk.base_ms, sk.inc_ms, sk.delay_ms,
    sk.tl_delay_ms,
    case owner_color when 1 then sk.owner else acceptor end,
    case owner_color when 2 then sk.owner else acceptor end,
    case owner_color when 1 then sk.owner_tab else acceptor_tab end,
    case owner_color when 2 then sk.owner_tab else acceptor_tab end,
    sk.start_to_move, sk.base_ms, sk.base_ms, sk.start_active, sk.delay_ms + sk.tl_delay_ms * sk.start_active, sk.rated);
  perform private.seat_players(sk.id);
  insert into public.active_players (player, game_id, role, navigate_tab) values
    (sk.owner, sk.id, owner_color, sk.owner_tab),
    (acceptor, sk.id, 3 - owner_color, acceptor_tab);
  if sk.private and sk.owner_left_voluntarily and sk.owner_away_since is not null then
    insert into private.presence (player, tab, page, ref, seen_at, left_at)
    values (sk.owner, sk.owner_tab, 'game', sk.id, sk.owner_away_since, sk.owner_away_since)
    on conflict (player, tab) do update set page = 'game', ref = sk.id, seen_at = excluded.seen_at, left_at = excluded.left_at;
  end if;
  return sk.id;
end $$;

/** Accept a seek (public or a private challenge). Returns the game id and your side. */
create or replace function public.seek_accept(p_token text, p_tab text, p_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  sk public.seeks;
  u uuid;
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  u := private.user_of(p);
  if private.user_busy(u) then raise exception 'You are already in a game.' using errcode = 'P0001'; end if;
  select * into sk from public.seeks s where s.id = p_id for update;
  if sk.id is null then raise exception 'Game aborted.' using errcode = 'P0001'; end if;
  if sk.owner = p then return jsonb_build_object('ignored', true); end if;
  if sk.rated then
    if u is null then raise exception 'Sign in to play rated games.' using errcode = 'P0001'; end if;
    if u = private.user_of(sk.owner) then raise exception 'You can''t play a rated game against yourself.' using errcode = 'P0001'; end if;
  end if;
  delete from public.seeks s where s.id = p_id;
  perform private.start_game(sk, p, p_tab);
  return jsonb_build_object('id', sk.id, 'role', (select role from public.active_players a where a.player = p));
end $$;

/** As before, and one game at a time per account; names the human side. */
create or replace function public.engine_game_create(p_token text, p_tab text, p_variant text, p_position text, p_setup text,
  p_start_to_move smallint, p_start_active integer, p_base_ms integer, p_inc_ms integer, p_delay_ms integer,
  p_tl_delay_ms integer, p_color smallint, p_level smallint, p_version text, p_book boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  id text := private.new_id();
  human smallint := coalesce(p_color, (1 + floor(random() * 2))::smallint);
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) or private.user_busy(private.user_of(p)) then
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
  perform private.seat_players(id);
  insert into public.active_players (player, game_id, role, navigate_tab) values (p, id, human, p_tab);
  return jsonb_build_object('id', id, 'role', human);
end $$;

/** As before; a rematch of a rated game is rated (both still signed in), with fresh ratings going in. */
create or replace function public.game_rematch(p_token text, p_tab text, p_id text, p_version text default null) returns jsonb
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
  if exists (select 1 from public.active_players a where a.player in (g.white, g.black))
     or private.user_busy(private.user_of(g.white)) or private.user_busy(private.user_of(g.black)) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  nid := private.new_id();
  insert into public.live_games (id, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms,
    tl_delay_ms, white, black, white_tab, black_tab, engine_color, engine, engine_version, engine_level, engine_book,
    to_move, white_ms, black_ms, active_timelines, turn_delay_ms, rated)
  select nid, variant, position, setup, start_to_move, start_active, private, base_ms, inc_ms, delay_ms, tl_delay_ms,
    black, white, black_tab, white_tab, case when engine_color is not null then 3 - engine_color end, engine,
    coalesce(left(p_version, 40), engine_version), engine_level, engine_book,
    start_to_move, base_ms, base_ms, start_active, delay_ms + tl_delay_ms * start_active,
    rated and private.user_of(g.white) is not null and private.user_of(g.black) is not null
  from public.live_games where id = p_id;
  perform private.seat_players(nid);
  insert into public.active_players (player, game_id, role, navigate_tab)
  select x.player, nid, x.role, x.tab from (values (g.black, 1::smallint, g.black_tab), (g.white, 2::smallint, g.white_tab)) as x(player, role, tab)
  where x.player is not null;
  update public.live_games set rematch_id = nid, updated_at = clock_timestamp() where id = p_id;
  return jsonb_build_object('id', nid, 'role', 3 - side);
end $$;

-- ---------------------------------------------------------------------------------- challenges

/**
 * As before, with whether the challenge is rated and who made it. Open a challenge link: {kind: 'open', owner, seek, ingame?} while it waits (its owner counts
 * as present), {kind: 'game', role?} once it became a game, else {kind: 'gone'}.
 */
create or replace function public.challenge_open(p_token text, p_tab text, p_id text) returns jsonb
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
        'color', sk.color, 'created_at', sk.created_at, 'rated', sk.rated, 'owner_name', sk.owner_name,
        'owner_rating', sk.owner_rating, 'owner_provisional', sk.owner_provisional),
      'ingame', case when a.player is not null then jsonb_build_object('id', a.game_id, 'role', a.role) end);
  end if;
  if exists (select 1 from public.live_games g where g.id = p_id) or exists (select 1 from public.games g where g.id = p_id) then
    select * into a from public.active_players x where x.player = p and x.game_id = p_id;
    return jsonb_build_object('kind', 'game', 'role', a.role);
  end if;
  return jsonb_build_object('kind', 'gone');
end $$;

-- ---------------------------------------------------------------------------------- profiles

/**
 * A player's profile page: the profile, rated results (wins, draws, losses), all games against
 * people and against Kairos (and by Kairos's level), the peak rating, and the rating after each
 * rated game (oldest first, for the chart).
 */
create function public.profile_view(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  out_ jsonb;
begin
  if not exists (select 1 from public.profiles where user_id = p_user) then return null; end if;
  with mine as (
    select pg.score, pg.rating_before, pg.rating_diff, g.rated, g.ended_at,
      exists (select 1 from public.engine_games e where e.game_id = g.id) as vs_kairos
    from public.player_games pg join public.games g on g.id = pg.game_id
    where pg.user_id = p_user and g.result <> '*')
  select private.profile_json(p_user)
    || jsonb_build_object('created_at', (select created_at from public.profiles where user_id = p_user),
      'rated', jsonb_build_object('games', count(*) filter (where rated),
        'wins', count(*) filter (where rated and score = 1), 'draws', count(*) filter (where rated and score = 0.5),
        'losses', count(*) filter (where rated and score = 0)),
      'people', jsonb_build_object('games', count(*) filter (where not vs_kairos),
        'wins', count(*) filter (where not vs_kairos and score = 1), 'draws', count(*) filter (where not vs_kairos and score = 0.5),
        'losses', count(*) filter (where not vs_kairos and score = 0)),
      'kairos', jsonb_build_object('games', count(*) filter (where vs_kairos),
        'wins', count(*) filter (where vs_kairos and score = 1), 'draws', count(*) filter (where vs_kairos and score = 0.5),
        'losses', count(*) filter (where vs_kairos and score = 0)),
      'peak', max(private.int_rating((rating_before + rating_diff)::real)) filter (where rated),
      'history', coalesce(jsonb_agg(jsonb_build_array((extract(epoch from ended_at) * 1000)::bigint,
        private.int_rating((rating_before + rating_diff)::real)) order by ended_at) filter (where rated and rating_diff is not null), '[]'::jsonb))
  into out_ from mine;
  return out_ || jsonb_build_object('kairos_levels', coalesce((
    select jsonb_object_agg(level, jsonb_build_object('games', n, 'wins', w, 'draws', d, 'losses', l))
    from (select e.strength_level as level, count(*) as n, count(*) filter (where pg.score = 1) as w,
        count(*) filter (where pg.score = 0.5) as d, count(*) filter (where pg.score = 0) as l
      from public.player_games pg join public.engine_games e on e.game_id = pg.game_id
        join public.games g on g.id = pg.game_id
      where pg.user_id = p_user and g.result <> '*' group by e.strength_level) x), '{}'::jsonb));
end $$;

/**
 * A page of a player's finished games, newest first: `p_kind` 'people' (against other players)
 * or 'kairos'; `p_before` (the last row's ended_at) continues a previous page.
 */
create function public.profile_games(p_user uuid, p_kind text default 'people', p_before timestamptz default null,
  p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((select jsonb_agg(row_ order by ended_at desc) from (
    select jsonb_build_object('id', g.id, 'ended_at', g.ended_at, 'variant', g.variant, 'result', g.result,
      'termination', g.termination, 'moves', g.move_count, 'rated', g.rated, 'color', pg.color, 'score', pg.score,
      'base_ms', g.base_ms, 'inc_ms', g.inc_ms, 'delay_ms', g.delay_ms, 'tl_delay_ms', g.tl_delay_ms,
      'rating', private.int_rating(pg.rating_before), 'diff', pg.rating_diff,
      'opponent', case pg.color when 1 then g.black_name else g.white_name end,
      'opponent_id', case pg.color when 1 then g.black_user else g.white_user end,
      'opponent_rating', private.int_rating(case pg.color when 1 then g.black_rating else g.white_rating end),
      'level', e.strength_level) as row_, g.ended_at
    from public.player_games pg join public.games g on g.id = pg.game_id
      left join public.engine_games e on e.game_id = g.id
    where pg.user_id = p_user and (p_before is null or g.ended_at < p_before)
      and case when p_kind = 'kairos' then e.game_id is not null else e.game_id is null end
    order by g.ended_at desc limit greatest(1, least(50, coalesce(p_limit, 20)))) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------- grants

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.seek_create from public, anon, authenticated;
grant execute on function public.seek_create to service_role;
revoke all on function public.account_link from public, anon;
grant execute on function public.account_link to authenticated;
grant execute on function public.account_me, public.account_unlink, public.profile_view, public.profile_games to anon, authenticated;
