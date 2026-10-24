-- Profiles after lichess's: a bio, renaming (once a month), last seen and online, time spent
-- playing, the puzzle rating, an activity timeline, and closing an account; and challenges sent
-- from a profile to one player, who sees them in the header and accepts or declines them.

alter table public.profiles
  add column bio text,
  add column renamed_at timestamptz,
  add column seen_at timestamptz;

-- ---------------------------------------------------------------------------------- closed accounts

-- A closed account that was barred from rated games stays barred: its sign-in identities (hashed)
-- bar the next account made with them.
create table private.banned_identities (
  provider text not null,
  id_hash text not null,
  at timestamptz not null default now(),
  primary key (provider, id_hash)
);
alter table private.banned_identities enable row level security;

create function private.identity_banned(u uuid) returns boolean language sql stable as $$
  select exists (select 1 from auth.identities i join private.banned_identities b
    on b.provider = i.provider and b.id_hash = encode(extensions.digest(i.provider_id, 'sha256'), 'hex')
    where i.user_id = u)
$$;

create function private.profile_created() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.identity_banned(new.user_id) then
    new.banned := true;
    new.banned_at := clock_timestamp();
  end if;
  new.seen_at := coalesce(new.seen_at, clock_timestamp());
  return new;
end $$;
create trigger profile_created before insert on public.profiles for each row execute function private.profile_created();

/**
 * Close the signed-in account (`p_confirm`: its name, as typed by the player): its profile,
 * rating, puzzle history and sign-in go; its finished games stay in the public record, played by
 * "Anonymous". Refused during a game, and for the last admin.
 */
create function public.account_delete(p_confirm text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  prof public.profiles;
  nm text;
begin
  if u is null then raise exception 'Sign in first.' using errcode = 'P0001'; end if;
  select * into prof from public.profiles where user_id = u for update;
  if prof.user_id is null then raise exception 'There is no account to close.' using errcode = 'P0001'; end if;
  if p_confirm is distinct from prof.name then raise exception 'Type your name to confirm.' using errcode = 'P0001'; end if;
  if private.user_busy(u) then raise exception 'Finish your game first.' using errcode = 'P0001'; end if;
  if prof.admin and (select count(*) from public.profiles where admin) <= 1 then
    raise exception 'The last admin can''t close their account.' using errcode = 'P0001';
  end if;
  nm := replace(prof.name, '"', '''');
  if prof.banned then
    insert into private.banned_identities (provider, id_hash)
    select i.provider, encode(extensions.digest(i.provider_id, 'sha256'), 'hex') from auth.identities i where i.user_id = u
    on conflict do nothing;
  end if;
  -- The games stay, played by "Anonymous".
  update public.games g set white_user = null, white_name = 'Anonymous',
    record = replace(g.record, format('[White "%s"]', nm), '[White "Anonymous"]') where g.white_user = u;
  update public.games g set black_user = null, black_name = 'Anonymous',
    record = replace(g.record, format('[Black "%s"]', nm), '[Black "Anonymous"]') where g.black_user = u;
  update public.live_games set white_user = null, white_name = null where white_user = u;
  update public.live_games set black_user = null, black_name = null where black_user = u;
  update public.player_games set user_id = null where user_id = u;
  delete from public.seeks s where s.to_user = u or s.owner in (select player from private.player_users where user_id = u);
  -- Puzzles, fair play, sign-in.
  delete from private.puzzle_rounds where player = 'u:' || u::text;
  delete from private.puzzle_players where player = 'u:' || u::text;
  delete from private.fairplay_assessments where user_id = u;
  delete from private.fairplay_cases where user_id = u;
  delete from private.analysis_matches where user_id = u;
  update private.rating_import set claimed_by = null, claimed_at = null where claimed_by = u;
  delete from private.player_users where user_id = u;
  delete from public.profiles where user_id = u;
  delete from auth.identities where user_id = u;
  delete from auth.users where id = u;
  return jsonb_build_object('closed', true);
end $$;

-- ---------------------------------------------------------------------------------- the profile

/**
 * Edit the signed-in player's profile: `p_name` (null: unchanged) is 3 to 20 letters, digits,
 * "_" or "-", starting and ending with a letter or digit, not taken by another player (in any
 * case), and changes at most once in 30 days; `p_bio` (null: unchanged; '' clears it) up to 400
 * characters. A new name is also written into the player's games and their records.
 */
create function public.account_update(p_name text default null, p_bio text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  prof public.profiles;
  nm text := btrim(p_name);
  old_ text;
  new_ text;
begin
  if u is null then raise exception 'Sign in first.' using errcode = 'P0001'; end if;
  select * into prof from public.profiles where user_id = u for update;
  if prof.user_id is null then raise exception 'Sign in first.' using errcode = 'P0001'; end if;
  if nm is not null and nm <> prof.name then
    if nm !~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,18}[A-Za-z0-9]$' then
      raise exception 'A name is 3 to 20 letters, digits, _ or -, starting and ending with a letter or digit.' using errcode = 'P0001';
    end if;
    if lower(nm) <> lower(prof.name) and exists (select 1 from public.profiles where lower(name) = lower(nm) and user_id <> u) then
      raise exception 'That name is taken.' using errcode = 'P0001';
    end if;
    if prof.renamed_at > clock_timestamp() - interval '30 days' then
      raise exception 'You can change your name again on %.', to_char(prof.renamed_at + interval '30 days', 'FMDD Month YYYY')
        using errcode = 'P0001';
    end if;
    old_ := replace(prof.name, '"', '''');
    new_ := nm;
    update public.profiles set name = nm, renamed_at = clock_timestamp() where user_id = u;
    update public.games g set white_name = nm, record = replace(g.record, format('[White "%s"]', old_), format('[White "%s"]', new_))
    where g.white_user = u;
    update public.games g set black_name = nm, record = replace(g.record, format('[Black "%s"]', old_), format('[Black "%s"]', new_))
    where g.black_user = u;
    update public.live_games set white_name = nm where white_user = u;
    update public.live_games set black_name = nm where black_user = u;
    update public.seeks set owner_name = nm where owner in (select player from private.player_users where user_id = u);
    update public.seeks set to_name = nm where to_user = u;
  end if;
  if p_bio is not null then
    if length(p_bio) > 400 then raise exception 'A bio is at most 400 characters.' using errcode = 'P0001'; end if;
    update public.profiles set bio = nullif(btrim(p_bio), '') where user_id = u;
  end if;
  return private.profile_json(u);
end $$;

/** A player's profile as the site shows it everywhere, with their bio. */
create or replace function private.profile_json(u uuid) returns jsonb language sql stable as $$
  select jsonb_build_object('user_id', p.user_id, 'name', p.name, 'rating', private.int_rating(r.rating), 'rd', round(r.rd),
    'provisional', private.provisional(r.rd), 'games', p.games, 'imported', p.imported, 'admin', p.admin, 'banned', p.banned,
    'bio', p.bio, 'renamed_at', p.renamed_at)
  from public.profiles p, private.current_rating(p.user_id) r where p.user_id = u
$$;

/**
 * Whether a player is on the site now (a game or lobby page of theirs pinged in the last minute, or
 * any page of theirs checked for challenges in the last two), and when they last were.
 */
create function private.last_seen(u uuid, out online boolean, out seen_at timestamptz) language sql stable as $$
  select coalesce(max(pr.seen_at) filter (where pr.left_at is null) > clock_timestamp() - interval '1 minute', false)
      or coalesce((select p.seen_at from public.profiles p where p.user_id = u) > clock_timestamp() - interval '2 minutes', false),
    greatest(max(pr.seen_at), (select p.seen_at from public.profiles p where p.user_id = u))
  from private.presence pr join private.player_users pu on pu.player = pr.player where pu.user_id = u
$$;

/** The signed-in player's profile; also marks them seen (each page load). */
create or replace function public.account_me(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := private.user_of(private.pid(p_token));
begin
  if u is null then return null; end if;
  update public.profiles set seen_at = clock_timestamp() where user_id = u;
  return private.profile_json(u);
end $$;

/**
 * A player's profile page: the profile, last seen and online, rated results, all games against
 * people and against Kairos (and by Kairos's level), the peak rating, the rating after each rated
 * game (oldest first, for the chart), its change over the last 12 rated games, the time spent
 * playing, and the puzzle rating.
 */
create or replace function public.profile_view(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  out_ jsonb;
  ls record;
  pz private.puzzle_players;
begin
  if not exists (select 1 from public.profiles where user_id = p_user) then return null; end if;
  with mine as (
    select pg.score, pg.rating_before, pg.rating_diff, g.rated, g.ended_at, g.duration_ms,
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
      'play_ms', coalesce(sum(duration_ms), 0),
      'history', coalesce(jsonb_agg(jsonb_build_array((extract(epoch from ended_at) * 1000)::bigint,
        private.int_rating((rating_before + rating_diff)::real)) order by ended_at) filter (where rated and rating_diff is not null), '[]'::jsonb))
  into out_ from mine;
  select * into ls from private.last_seen(p_user);
  select * into pz from private.puzzle_players where player = 'u:' || p_user::text;
  return out_ || jsonb_build_object(
    'online', ls.online, 'seen_at', ls.seen_at,
    'progress', (select sum(rating_diff) from (select pg.rating_diff from public.player_games pg join public.games g on g.id = pg.game_id
      where pg.user_id = p_user and g.rated and pg.rating_diff is not null order by g.ended_at desc limit 12) x),
    'puzzles', case when pz.player is not null then jsonb_build_object('rating', private.int_rating(pz.rating),
      'provisional', private.provisional(pz.rd), 'played', pz.rounds) end,
    'kairos_levels', coalesce((
      select jsonb_object_agg(level, jsonb_build_object('games', n, 'wins', w, 'draws', d, 'losses', l))
      from (select e.strength_level as level, count(*) as n, count(*) filter (where pg.score = 1) as w,
          count(*) filter (where pg.score = 0.5) as d, count(*) filter (where pg.score = 0) as l
        from public.player_games pg join public.engine_games e on e.game_id = pg.game_id
          join public.games g on g.id = pg.game_id
        where pg.user_id = p_user and g.result <> '*' group by e.strength_level) x), '{}'::jsonb));
end $$;

/**
 * A player's activity (lichess's timeline) over the last `p_days` days: their finished games
 * (rated, casual or against Kairos, with the result, the rating change and the opponent) and
 * their puzzle rounds, newest first, for the page to group by day in the reader's time zone; and
 * when they signed up.
 */
create function public.profile_activity(p_user uuid, p_days integer default 60) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare since timestamptz := clock_timestamp() - make_interval(days => greatest(1, least(365, coalesce(p_days, 60))));
begin
  if not exists (select 1 from public.profiles where user_id = p_user) then return null; end if;
  return jsonb_build_object(
    'created_at', (select created_at from public.profiles where user_id = p_user),
    'games', coalesce((select jsonb_agg(x.row_ order by x.at desc) from (
      select g.ended_at as at, jsonb_build_object('id', g.id, 'at', g.ended_at, 'rated', g.rated, 'score', pg.score,
        'diff', pg.rating_diff, 'after', private.int_rating((pg.rating_before + pg.rating_diff)::real),
        'level', e.strength_level, 'variant', g.variant,
        'opponent', case pg.color when 1 then g.black_name else g.white_name end,
        'opponent_id', case pg.color when 1 then g.black_user else g.white_user end) as row_
      from public.player_games pg join public.games g on g.id = pg.game_id
        left join public.engine_games e on e.game_id = g.id
      where pg.user_id = p_user and g.result <> '*' and g.ended_at > since
      order by g.ended_at desc limit 500) x), '[]'::jsonb),
    'puzzles', coalesce((select jsonb_agg(jsonb_build_array((extract(epoch from r.at) * 1000)::bigint, r.win, r.rating_diff) order by r.at desc)
      from (select * from private.puzzle_rounds where player = 'u:' || p_user::text and at > since order by at desc limit 2000) r), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------- challenges to a player

alter table public.seeks
  add column to_user uuid,
  add column to_name text;
create index seeks_to_user on public.seeks (to_user) where to_user is not null;

drop function public.seek_create(text, text, boolean, text, text, text, smallint, integer, integer, integer, integer, integer, smallint, boolean);

/**
 * Create a seek (public, or a private challenge) for the player: replaces any seek they had. A
 * rated one needs a signed-in player, a clock and a rated variant. `p_to_user`: a challenge to
 * that player (from a signed-in player; private), which only they can accept and which they see
 * in their header. Called by the `game` edge function, which has checked the position and time
 * control.
 */
create function public.seek_create(p_token text, p_tab text, p_private boolean, p_variant text, p_position text,
  p_setup text, p_start_to_move smallint, p_start_active integer, p_base_ms integer, p_inc_ms integer,
  p_delay_ms integer, p_tl_delay_ms integer, p_color smallint, p_rated boolean default false, p_to_user uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  id text;
  me record;
  rated boolean := coalesce(p_rated, false);
  priv boolean := coalesce(p_private, false) or p_to_user is not null;
  to_name text;
begin
  perform private.check_tab(p_tab);
  if exists (select 1 from public.active_players a where a.player = p) then
    raise exception 'You are already in a game.' using errcode = 'P0001';
  end if;
  select * into me from private.seat(p);
  if private.user_busy(me.user_id) then raise exception 'You are already in a game.' using errcode = 'P0001'; end if;
  if p_to_user is not null then
    if me.user_id is null then raise exception 'Sign in to challenge a player.' using errcode = 'P0001'; end if;
    if p_to_user = me.user_id then raise exception 'You can''t challenge yourself.' using errcode = 'P0001'; end if;
    select name into to_name from public.profiles where user_id = p_to_user;
    if to_name is null then raise exception 'There is no such player.' using errcode = 'P0001'; end if;
  end if;
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
    base_ms, inc_ms, delay_ms, tl_delay_ms, color, owner_away_since, rated, owner_name, owner_rating, owner_provisional,
    to_user, to_name)
  values (id, p, p_tab, priv, p_variant, p_position, p_setup, p_start_to_move, p_start_active,
    p_base_ms, coalesce(p_inc_ms, 0), coalesce(p_delay_ms, 0), coalesce(p_tl_delay_ms, 0), p_color,
    case when priv then clock_timestamp() end, rated, me.name, private.int_rating(me.rating), private.provisional(me.rd),
    p_to_user, to_name);
  if not priv then
    insert into private.presence (player, tab, page, ref, seen_at) values (p, p_tab, 'lobby', null, clock_timestamp())
      on conflict (player, tab) do update set page = 'lobby', ref = null, seen_at = excluded.seen_at, left_at = null;
  end if;
  return jsonb_build_object('id', id);
end $$;

/** Accept a seek (public or a private challenge; one to a player, only by them). Returns the game id and your side. */
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
  if sk.to_user is not null and u is distinct from sk.to_user then
    raise exception 'This challenge is for %.', sk.to_name using errcode = 'P0001';
  end if;
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

/** A challenge's page: as before, with whom a challenge to a player is for. */
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
        'owner_rating', sk.owner_rating, 'owner_provisional', sk.owner_provisional,
        'owner_user', private.user_of(sk.owner), 'to_user', sk.to_user, 'to_name', sk.to_name),
      'ingame', case when a.player is not null then jsonb_build_object('id', a.game_id, 'role', a.role) end);
  end if;
  if exists (select 1 from public.live_games g where g.id = p_id) or exists (select 1 from public.games g where g.id = p_id) then
    select * into a from public.active_players x where x.player = p and x.game_id = p_id;
    return jsonb_build_object('kind', 'game', 'role', a.role);
  end if;
  return jsonb_build_object('kind', 'gone');
end $$;

/**
 * The challenges sent to the signed-in player that are still open, newest first. Every page of a
 * signed-in player asks every few seconds, so this also marks them seen (once a minute at most).
 */
create function public.challenges_incoming() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then return '[]'::jsonb; end if;
  update public.profiles set seen_at = clock_timestamp()
  where user_id = u and (seen_at is null or seen_at < clock_timestamp() - interval '1 minute');
  return coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'variant', s.variant, 'base_ms', s.base_ms, 'inc_ms', s.inc_ms,
      'delay_ms', s.delay_ms, 'tl_delay_ms', s.tl_delay_ms, 'color', s.color, 'rated', s.rated, 'created_at', s.created_at,
      'owner_name', s.owner_name, 'owner_rating', s.owner_rating, 'owner_provisional', s.owner_provisional,
      'owner_user', private.user_of(s.owner)) order by s.created_at desc)
    from public.seeks s where s.to_user = u), '[]'::jsonb);
end $$;

/** Decline a challenge sent to the signed-in player: it goes (the challenger's page hears so). */
create function public.challenge_decline(p_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid();
begin
  if u is null then return false; end if;
  delete from public.seeks s where s.id = p_id and s.to_user = u;
  return found;
end $$;

-- ---------------------------------------------------------------------------------- community

/**
 * Every player (the site is small): name, rating, games, whether they are on the site now and
 * when they last were, the rating change over their last 12 rated games, and their badges; for
 * the Players page and the leaderboard.
 */
create function public.community() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', p.name,
      'rating', private.int_rating(r.rating), 'rd', round(r.rd), 'provisional', private.provisional(r.rd),
      'games', p.games, 'online', ls.online, 'seen_at', ls.seen_at, 'created_at', p.created_at,
      'admin', p.admin, 'banned', p.banned,
      'progress', (select sum(x.rating_diff) from (select pg.rating_diff from public.player_games pg
        join public.games g on g.id = pg.game_id where pg.user_id = p.user_id and g.rated and pg.rating_diff is not null
        order by g.ended_at desc limit 12) x)))
    from public.profiles p, private.current_rating(p.user_id) r, private.last_seen(p.user_id) ls), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------- grants

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.seek_create from public, anon, authenticated;
grant execute on function public.seek_create to service_role;
revoke all on function public.account_delete, public.account_update, public.challenges_incoming, public.challenge_decline
  from public, anon;
grant execute on function public.account_delete, public.account_update, public.challenges_incoming, public.challenge_decline
  to authenticated;
grant execute on function public.profile_activity, public.profile_view, public.account_me, public.community to anon, authenticated;
