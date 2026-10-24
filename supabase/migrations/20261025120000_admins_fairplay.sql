-- Admins, a guest's history moving into their account, and fair play (engine-assistance
-- detection): per-action interaction signals, the detector's evidence and cases, and the admins'
-- review of cases. See docs/FAIR_PLAY.md for the detector as a whole.
--
-- Admins are accounts with `admin` set; an admin can promote or demote any account and review
-- cases. A case is opened by the detector (a GitHub Actions job: scripts/fairplay/detect.mjs) and
-- never acts on a player by itself: an admin dismisses it (the evidence so far stops counting) or
-- bans the player from rated games (a confirmed cheater, kept for calibrating the detector).

-- ---------------------------------------------------------------------------------- admins and bans

alter table public.profiles
  add column admin boolean not null default false,
  add column banned boolean not null default false,
  add column banned_at timestamptz,
  add column fairplay_cutoff timestamptz;   -- evidence before this (a dismissed case) no longer counts

-- Accounts that are admins from the start (the site's owner): now, and when their profile is made.
create table private.admin_seed (user_id uuid primary key);
alter table private.admin_seed enable row level security;
insert into private.admin_seed (user_id) values ('e53c7544-54fa-46ed-b276-4fc2554584ca');
update public.profiles set admin = true where user_id in (select user_id from private.admin_seed);

create function private.is_admin(u uuid) returns boolean language sql stable as $$
  select coalesce((select admin from public.profiles where user_id = u), false)
$$;

/** The signed-in admin's id; throws for anyone else. */
create function private.require_admin() returns uuid language plpgsql stable as $$
declare u uuid := auth.uid();
begin
  if u is null or not private.is_admin(u) then raise exception 'Admins only.' using errcode = 'P0001'; end if;
  return u;
end $$;

create or replace function private.profile_json(u uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', p.user_id, 'name', p.name, 'rating', private.int_rating(r.rating), 'rd', round(r.rd),
    'provisional', private.provisional(r.rd), 'games', p.games, 'imported', p.imported, 'admin', p.admin, 'banned', p.banned)
  from public.profiles p, private.current_rating(p.user_id) r where p.user_id = u
$$;

/** Make an account an admin or not (admins only; the last admin stays one). */
create function public.admin_set(p_user uuid, p_admin boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if not p_admin and (select count(*) from public.profiles where admin) <= 1 and private.is_admin(p_user) then
    raise exception 'The last admin can''t be removed.' using errcode = 'P0001';
  end if;
  update public.profiles set admin = coalesce(p_admin, false) where user_id = p_user;
  return private.profile_json(p_user);
end $$;

/** Bar an account from rated games, or lift the bar (admins only). */
create function public.admin_ban(p_user uuid, p_banned boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  update public.profiles set banned = coalesce(p_banned, false), banned_at = case when p_banned then clock_timestamp() end
  where user_id = p_user;
  return private.profile_json(p_user);
end $$;

-- ---------------------------------------------------------------------------------- a guest's history

/**
 * Move everything this browser did as a guest into account u (at its first sign-in here, and
 * harmlessly again later): its finished games (named after the account from then on) and its
 * puzzle rating and rounds (which, once signed in, belong to the account). When the account
 * already has a puzzle rating, it keeps it and gains the rounds it hasn't played.
 */
create function private.adopt(p text, u uuid) returns void language plpgsql as $$
declare
  nm text := replace((select name from public.profiles where user_id = u), '"', '''');
  k text := 'u:' || u::text;
begin
  update public.player_games set user_id = u where player = p and user_id is null;
  update public.games g set white_user = u, white_name = nm,
    record = replace(g.record, '[White "Anonymous"]', format('[White "%s"]', nm))
  where g.white_user is null and exists (select 1 from public.player_games pg where pg.game_id = g.id and pg.player = p and pg.color = 1);
  update public.games g set black_user = u, black_name = nm,
    record = replace(g.record, '[Black "Anonymous"]', format('[Black "%s"]', nm))
  where g.black_user is null and exists (select 1 from public.player_games pg where pg.game_id = g.id and pg.player = p and pg.color = 2);
  if exists (select 1 from private.puzzle_players where player = p) then
    if not exists (select 1 from private.puzzle_players where player = k) then
      update private.puzzle_players set player = k where player = p;
      update private.puzzle_rounds set player = k where player = p;
    else
      insert into private.puzzle_rounds (player, puzzle, at, win, rated, rating_diff)
      select k, puzzle, at, win, rated, rating_diff from private.puzzle_rounds where player = p
      on conflict (player, puzzle) do nothing;
      delete from private.puzzle_rounds where player = p;
      delete from private.puzzle_players where player = p;
    end if;
  end if;
end $$;

/** The puzzle identity of a token: its account once signed in, else the token's player id. */
create function private.puzzle_key(p_token text) returns text language sql stable as $$
  select coalesce('u:' || private.user_of(private.pid(p_token))::text, private.pid(p_token))
$$;

create or replace function public.account_link(p_token text) returns jsonb
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
    insert into public.profiles (user_id, name, admin) values (u, nm, exists (select 1 from private.admin_seed s where s.user_id = u))
      returning * into prof;
  end if;
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
  -- Whatever this browser did as a guest becomes the account's.
  perform private.adopt(p, u);
  return private.profile_json(u);
end $$;

-- ---------------------------------------------------------------------------------- puzzles by account
-- As before, but a signed-in player's puzzle rating and rounds belong to the account (puzzle_key).

/**
 * The next puzzle for the player: in `p_theme` (null: any); within [`p_min`, `p_max`] when
 * given (any one of them), else the closest to the player's rating moved by `p_offset`
 * (lichess's difficulty: -600 easiest to +600 hardest), with some spread so that the same
 * rating does not always give the same puzzle; never one in `p_skip` (this session's), and not
 * one already played unless `p_replay` (then the unplayed come first). Null when none is left.
 */
create or replace function public.puzzle_next(p_token text, p_theme text default null, p_min integer default null,
  p_max integer default null, p_offset integer default 0, p_skip text[] default '{}', p_replay boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.puzzle_key(p_token);
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
create or replace function public.puzzle_get(p_token text, p_id text) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.puzzle_key(p_token);
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
create or replace function public.puzzle_round(p_token text, p_id text, p_win boolean, p_rated boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.puzzle_key(p_token);
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
create or replace function public.puzzle_dashboard(p_token text, p_min integer default null, p_max integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  me text := private.puzzle_key(p_token);
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


-- ---------------------------------------------------------------------------------- bans
-- As before; an account barred from rated games can't create or accept one.

/**
 * Create a seek (public, or a private challenge) for the player: replaces any seek they had. A
 * rated one needs a signed-in player, a clock and a rated variant. Called by the `game` edge
 * function, which has checked the position and time control.
 */
create or replace function public.seek_create(p_token text, p_tab text, p_private boolean, p_variant text, p_position text,
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
    if (select banned from public.profiles where user_id = me.user_id) then
      raise exception 'Your account is barred from rated games.' using errcode = 'P0001';
    end if;
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
    if (select banned from public.profiles where user_id = u) then
      raise exception 'Your account is barred from rated games.' using errcode = 'P0001';
    end if;
    if u = private.user_of(sk.owner) then raise exception 'You can''t play a rated game against yourself.' using errcode = 'P0001'; end if;
  end if;
  delete from public.seeks s where s.id = p_id;
  perform private.start_game(sk, p, p_tab);
  return jsonb_build_object('id', sk.id, 'role', (select role from public.active_players a where a.player = p));
end $$;


-- ---------------------------------------------------------------------------------- interaction signals

-- What the player's page saw during their turn, sent with each action (see online.js, `signals`):
-- for fair play only, never shown publicly, kept 180 days. Client data can only ever add
-- suspicion: a cheater controls their page, so normal or missing signals clear nobody.
create table private.move_signals (
  game_id text not null,
  ply integer not null,                  -- the game's length before the action
  side smallint not null,
  signals jsonb not null,
  at timestamptz not null default now(),
  primary key (game_id, ply)
);
create index move_signals_at on private.move_signals (at);
alter table private.move_signals enable row level security;

-- The analysis board in another window or on another device. While a rated game between people
-- is live, the edge function keeps a hash of each of its positions (computed by the rules core
-- from the actions, not sent by a page), and the database the fingerprint of each player's
-- browser (sent with their actions); an analysis board reports the hash of what it shows with
-- its own browser's fingerprint (fairplay_seen), and when that is the live game's current
-- position, from action 6 on, the match is kept, for the player whose account it is signed in
-- with or whose browser it is. A spectator analysing the game is someone else; one on the same
-- kind of machine could share a fingerprint, so a match is evidence for review, never proof
-- (docs/FAIR_PLAY.md).
create table private.position_keys (
  game_id text not null,
  ply integer not null,                  -- the game's length at the position
  key text not null,
  at timestamptz not null default now(),
  primary key (game_id, ply)
);
alter table private.position_keys enable row level security;
create table private.live_prints (
  game_id text not null,
  side smallint not null,
  fp text not null,
  primary key (game_id, side)
);
create index live_prints_fp on private.live_prints (fp);
alter table private.live_prints enable row level security;
create table private.analysis_matches (
  game_id text not null,
  ply integer not null,
  user_id uuid not null,
  side smallint not null,
  via text not null,                     -- 'account' or 'browser'
  at timestamptz not null default now(),
  primary key (game_id, ply, user_id)
);
create index analysis_matches_at on private.analysis_matches (at);
alter table private.analysis_matches enable row level security;

drop function public.game_apply_move(text, text, text, integer, text, text, text, boolean, smallint, integer, text);

/**
 * An analysis board shows the position with hash `p_key`, in the browser with fingerprint `p_fp`
 * (signed in or not). False: no live rated game of this account or browser (stop sending for a while).
 */
create function public.fairplay_seen(p_key text, p_fp text default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); g record; any_ boolean := false;
begin
  for g in
    select l.id, l.ply, s.side, case s.side when 1 then l.white_user else l.black_user end as user_id,
      case when (case s.side when 1 then l.white_user else l.black_user end) = u then 'account' else 'browser' end as via
    from public.live_games l cross join (values (1::smallint), (2::smallint)) s(side)
    where l.result is null and l.rated and l.engine_color is null
      and ((u is not null and (case s.side when 1 then l.white_user else l.black_user end) = u)
        or (p_fp is not null and exists (select 1 from private.live_prints f where f.game_id = l.id and f.side = s.side and f.fp = p_fp)))
  loop
    any_ := true;
    if g.ply >= 6 and g.user_id is not null
      and exists (select 1 from private.position_keys k where k.game_id = g.id and k.ply = g.ply and k.key = p_key) then
      insert into private.analysis_matches (game_id, ply, user_id, side, via) values (g.id, g.ply, g.user_id, g.side, g.via)
      on conflict do nothing;
    end if;
  end loop;
  return any_;
end $$;

/**
 * Apply an action the edge function has checked: `p_ply` is the game's length before it (a stale
 * or out-of-turn submission returns the game as it is, for the client to resync). `p_status` is
 * the rules core's verdict after the action (checkmate | stalemate | exiled-white | exiled-black).
 * `p_signals`: what the player's page saw during the turn (private.move_signals); `p_key`: the
 * hash of the position after it (private.position_keys).
 */
create function public.game_apply_move(p_token text, p_tab text, p_id text, p_ply integer, p_lan text, p_san text,
  p_full text, p_lone boolean, p_next_to_move smallint, p_active integer, p_status text, p_signals jsonb default null,
  p_key text default null)
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
  -- The page's signals for a person's action (not Kairos's, whose actions the page also sends).
  if mover = side and p_signals is not null and jsonb_typeof(p_signals) = 'object' and length(p_signals::text) <= 2000 then
    insert into private.move_signals (game_id, ply, side, signals) values (p_id, g.ply, side, p_signals) on conflict do nothing;
  end if;
  if p_key is not null and g.rated and g.engine_color is null then
    insert into private.position_keys (game_id, ply, key) values (p_id, g.ply + 1, left(p_key, 64))
    on conflict (game_id, ply) do update set key = excluded.key, at = excluded.at;
    if mover = side and p_signals ? 'fp' then
      insert into private.live_prints (game_id, side, fp) values (p_id, side, left(p_signals->>'fp', 64))
      on conflict on constraint live_prints_pkey do update set fp = excluded.fp;
    end if;
  end if;
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

/**
 * Every few seconds (pg_cron): run every live game's timers, drop public seeks whose owner left
 * the lobby (5 s after their pings stopped) and challenges whose owner has been away 10 minutes,
 * and forget old presence.
 */
create or replace function private.sweep() returns void language plpgsql as $$
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
  delete from private.move_signals where at < clock_timestamp() - interval '180 days';
  delete from private.analysis_matches where at < clock_timestamp() - interval '180 days';
  -- Position hashes are only needed while their game is live.
  delete from private.position_keys k where not exists (select 1 from public.live_games g where g.id = k.game_id and g.result is null);
  delete from private.live_prints k where not exists (select 1 from public.live_games g where g.id = k.game_id and g.result is null);
end $$;

-- ---------------------------------------------------------------------------------- the detector's data

-- The detector authenticates with a key whose SHA-256 is here (the key itself is a GitHub
-- Actions secret); it reads and writes only through the functions below.
create table private.detector_keys (hash text primary key);
alter table private.detector_keys enable row level security;
insert into private.detector_keys (hash) values ('0835cc5af4581c23b9b0c50008f3c7aeaf5d167c659e14cf3de40438608c687b');

-- One row per player per assessed rated game: the evidence of their actions (JSON, see
-- static/js/fairplay-score.js), or why there is none.
create table private.fairplay_assessments (
  game_id text not null,
  user_id uuid not null,
  color smallint not null,
  outcome text not null check (outcome in ('analysed', 'unsupported', 'failed')),
  evidence jsonb,
  updated_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index fairplay_assessments_user on private.fairplay_assessments (user_id, updated_at);
alter table private.fairplay_assessments enable row level security;

create table private.fairplay_cases (
  id bigserial primary key,
  user_id uuid not null,
  opened_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'dismissed', 'banned')),
  reason text not null,                 -- 'moves' (the betting score), 'engine-tab', 'analysis-match', 'away' or 'timing'
  score real,                           -- the betting score's log when it opened
  detail jsonb,
  decided_at timestamptz,
  decided_by uuid,
  note text
);
create unique index fairplay_one_open_case on private.fairplay_cases (user_id) where status = 'open';
alter table private.fairplay_cases enable row level security;

/** Throws unless `p_key` is the detector's. */
create function private.detector(p_key text) returns void language plpgsql stable as $$
begin
  if p_key is null or not exists (select 1 from private.detector_keys where hash = encode(extensions.digest(p_key, 'sha256'), 'hex')) then
    raise exception 'not the detector' using errcode = '42501';
  end if;
end $$;

/** Rated games between two people that ended and haven't been assessed yet (oldest first). */
create function private.fairplay_pending() returns setof public.games language sql stable as $$
  select g.* from public.games g
  where g.rated and g.result <> '*' and g.white_user is not null and g.black_user is not null
    and not exists (select 1 from public.engine_games e where e.game_id = g.id)
    and not exists (select 1 from private.fairplay_assessments a where a.game_id = g.id)
  order by g.ended_at
$$;

/** The detector's queue: up to `p_limit` games to assess, with each side's rating going in. */
create function public.fairplay_queue(p_key text, p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.detector(p_key);
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'position', g.position, 'variant', g.variant,
      'moves', g.moves, 'ended_at', g.ended_at, 'white_user', g.white_user, 'black_user', g.black_user,
      'white_rating', g.white_rating, 'black_rating', g.black_rating, 'white_rd', g.white_rd, 'black_rd', g.black_rd,
      'signals', coalesce((select jsonb_object_agg(s.ply, s.signals) from private.move_signals s where s.game_id = g.id), '{}'::jsonb),
      'matches', coalesce((select jsonb_agg(jsonb_build_object('ply', m.ply, 'side', m.side, 'via', m.via) order by m.ply) from private.analysis_matches m where m.game_id = g.id), '[]'::jsonb))
    order by g.ended_at)
    from (select * from private.fairplay_pending() limit greatest(1, least(100, coalesce(p_limit, 20)))) g), '[]'::jsonb);
end $$;

/** Store one player's assessment of a game. */
create function public.fairplay_store(p_key text, p_game text, p_user uuid, p_color smallint, p_outcome text, p_evidence jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.detector(p_key);
  insert into private.fairplay_assessments (game_id, user_id, color, outcome, evidence)
  values (p_game, p_user, p_color, p_outcome, p_evidence)
  on conflict (game_id, user_id) do update set outcome = excluded.outcome, evidence = excluded.evidence, updated_at = now();
end $$;

/**
 * A player's evidence that still counts, oldest first: analysed games of the last 6 months
 * since their last dismissed case, with their rating and deviation going into each; and whether
 * a case is open (then the detector doesn't score them).
 */
create function public.fairplay_history(p_key text, p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cutoff timestamptz;
begin
  perform private.detector(p_key);
  select greatest(clock_timestamp() - interval '6 months', coalesce(fairplay_cutoff, '-infinity'::timestamptz))
    into cutoff from public.profiles where user_id = p_user;
  return jsonb_build_object(
    'open', exists (select 1 from private.fairplay_cases c where c.user_id = p_user and c.status = 'open'),
    'banned', coalesce((select banned from public.profiles where user_id = p_user), false),
    'games', coalesce((select jsonb_agg(jsonb_build_object('game_id', a.game_id, 'color', a.color, 'evidence', a.evidence,
        'rating', pg.rating_before, 'rd', pg.rd_before) order by a.updated_at)
      from private.fairplay_assessments a
        join public.player_games pg on pg.game_id = a.game_id and pg.color = a.color
      where a.user_id = p_user and a.outcome = 'analysed' and a.updated_at > cutoff), '[]'::jsonb));
end $$;

/** Open a case on a player (none while one is open). Returns it with the player's name and rating (for the admins' channel), or null. */
create function public.fairplay_open(p_key text, p_user uuid, p_reason text, p_score real, p_detail jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare id_ bigint;
begin
  perform private.detector(p_key);
  insert into private.fairplay_cases (user_id, reason, score, detail) values (p_user, p_reason, p_score, p_detail)
  on conflict (user_id) where status = 'open' do nothing
  returning id into id_;
  if id_ is null then return null; end if;
  return jsonb_build_object('id', id_, 'user_id', p_user, 'name', p.name, 'rating', private.int_rating(r.rating),
    'provisional', private.provisional(r.rd), 'games', p.games)
  from public.profiles p, private.current_rating(p_user) r where p.user_id = p_user;
end $$;

-- ---------------------------------------------------------------------------------- reviewing cases

/** For the header: open cases, for an admin (null for anyone else). */
create function public.admin_status() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin(auth.uid()) then return null; end if;
  return jsonb_build_object('open_cases', (select count(*) from private.fairplay_cases where status = 'open'),
    'pending_games', (select count(*) from private.fairplay_pending()));
end $$;

/** Cases with `p_status` ('open', 'dismissed', 'banned'; null: all), newest first (admins only). */
create function public.fairplay_cases(p_status text default 'open') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'user_id', c.user_id, 'name', p.name,
      'rating', private.int_rating(p.rating), 'games', p.games, 'opened_at', c.opened_at, 'status', c.status,
      'reason', c.reason, 'score', c.score, 'decided_at', c.decided_at, 'note', c.note) order by c.opened_at desc)
    from private.fairplay_cases c join public.profiles p on p.user_id = c.user_id
    where p_status is null or c.status = p_status), '[]'::jsonb);
end $$;

/**
 * One case for review (admins only): the case, the player's profile, and every assessed game of
 * theirs that counted when it opened (and since), with the evidence, the game's record (moves
 * and clocks) and the page's signals for their actions.
 */
create function public.fairplay_case(p_case bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c private.fairplay_cases; cutoff timestamptz;
begin
  perform private.require_admin();
  select * into c from private.fairplay_cases where id = p_case;
  if c.id is null then return null; end if;
  select greatest(c.opened_at - interval '6 months', coalesce(
    (select max(decided_at) from private.fairplay_cases d where d.user_id = c.user_id and d.status = 'dismissed' and d.decided_at < c.opened_at),
    '-infinity'::timestamptz)) into cutoff;
  return jsonb_build_object('case', to_jsonb(c), 'profile', private.profile_json(c.user_id),
    'games', coalesce((select jsonb_agg(jsonb_build_object('game_id', a.game_id, 'color', a.color, 'outcome', a.outcome,
        'evidence', a.evidence, 'assessed_at', a.updated_at, 'ended_at', g.ended_at, 'result', g.result,
        'termination', g.termination, 'variant', g.variant, 'base_ms', g.base_ms, 'inc_ms', g.inc_ms,
        'tl_delay_ms', g.tl_delay_ms, 'moves', g.moves, 'rating', pg.rating_before, 'rd', pg.rd_before, 'diff', pg.rating_diff,
        'opponent', case a.color when 1 then g.black_name else g.white_name end,
        'opponent_id', case a.color when 1 then g.black_user else g.white_user end,
        'signals', coalesce((select jsonb_object_agg(s.ply, s.signals) from private.move_signals s
          where s.game_id = a.game_id and s.side = a.color), '{}'::jsonb),
        'matches', coalesce((select jsonb_agg(jsonb_build_object('ply', m.ply, 'via', m.via) order by m.ply) from private.analysis_matches m
          where m.game_id = a.game_id and m.side = a.color), '[]'::jsonb)) order by a.updated_at)
      from private.fairplay_assessments a
        join public.games g on g.id = a.game_id
        join public.player_games pg on pg.game_id = a.game_id and pg.color = a.color
      where a.user_id = c.user_id and a.updated_at > cutoff), '[]'::jsonb));
end $$;

/**
 * Decide a case (admins only): 'dismiss' (the player is cleared: the evidence so far stops
 * counting toward future cases) or 'ban' (a confirmed cheater: barred from rated games).
 */
create function public.fairplay_decide(p_case bigint, p_action text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := private.require_admin(); c private.fairplay_cases;
begin
  select * into c from private.fairplay_cases where id = p_case for update;
  if c.id is null or c.status <> 'open' then raise exception 'That case is not open.' using errcode = 'P0001'; end if;
  if p_action = 'dismiss' then
    update private.fairplay_cases set status = 'dismissed', decided_at = clock_timestamp(), decided_by = me, note = left(p_note, 2000)
    where id = p_case;
    update public.profiles set fairplay_cutoff = clock_timestamp() where user_id = c.user_id;
  elsif p_action = 'ban' then
    update private.fairplay_cases set status = 'banned', decided_at = clock_timestamp(), decided_by = me, note = left(p_note, 2000)
    where id = p_case;
    update public.profiles set banned = true, banned_at = clock_timestamp() where user_id = c.user_id;
  else
    raise exception 'Dismiss or ban.' using errcode = 'P0001';
  end if;
  return public.fairplay_cases(null);
end $$;

-- ---------------------------------------------------------------------------------- starting the detector

-- The detector runs on GitHub Actions, started only when there is new work: every 15 minutes the
-- database looks for a rated game between people that ended since the last look and still waits
-- for assessment and, if there is one, asks GitHub to run the `fairplay` workflow (pg_net, with
-- a GitHub token kept in Supabase Vault as 'github_fairplay_token'); the run takes every waiting
-- game, older ones too. A quiet site starts nothing (nor does a run that keeps failing, until the
-- next new game). With no token, nothing starts.
create table private.fairplay_runs (at timestamptz primary key default now());
alter table private.fairplay_runs enable row level security;

create function private.fairplay_dispatch() returns void language plpgsql security definer set search_path = '' as $$
declare tok text;
begin
  -- A minute of overlap between looks, so that no game falls between two.
  if not exists (select 1 from private.fairplay_pending() g where g.ended_at > clock_timestamp() - interval '16 minutes') then return; end if;
  if exists (select 1 from private.fairplay_runs where at > clock_timestamp() - interval '10 minutes') then return; end if;
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''github_fairplay_token'' limit 1' into tok;
  if tok is null then return; end if;
  insert into private.fairplay_runs (at) values (clock_timestamp());
  delete from private.fairplay_runs where at < clock_timestamp() - interval '7 days';
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.github.com/repos/FirePlank/5d-chess-lab/actions/workflows/fairplay.yml/dispatches',
      '{"ref": "main"}'::jsonb,
      jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
        'User-Agent', '5d-chess-lab', 'X-GitHub-Api-Version', '2022-11-28', 'Content-Type', 'application/json');
end $$;

/** Whether the database can start the detector (pg_net and the GitHub token in Vault): a yes or no, never the token. */
create function public.fairplay_ready() returns boolean language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then return false; end if;
  execute 'select count(*) from vault.decrypted_secrets where name = ''github_fairplay_token'' and length(decrypted_secret) > 20' into n;
  return n > 0;
end $$;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('5d-chess-lab-fairplay', '*/15 * * * *', 'select private.fairplay_dispatch()');
  end if;
end $$;

-- ---------------------------------------------------------------------------------- grants

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function public.admin_set, public.admin_ban, public.admin_status, public.fairplay_cases,
  public.fairplay_case, public.fairplay_decide to authenticated;
grant execute on function public.fairplay_queue, public.fairplay_store, public.fairplay_history, public.fairplay_open
  to anon, authenticated;
grant execute on function public.fairplay_seen, public.fairplay_ready to anon, authenticated;
revoke all on function public.game_apply_move from public, anon, authenticated;
grant execute on function public.game_apply_move to service_role;
