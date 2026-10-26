-- Faster, fairer moves.
--
-- One write per action: game_apply_move used to update the live row three times (the action, its
-- clock, the clock comment) and a game's end twice more (the result, then the rating changes),
-- and realtime sends every update to every page watching the game. Now the action, its clock, the
-- game's end and the rating changes are worked out first and written in one update: one message
-- per action for each watcher.
--
-- Lag compensation (lila's, after scalachess's LagTracker): the page sends how long the player
-- thought, as it measured it (from the opponent's action reaching it to its own action leaving
-- it); the server's elapsed time beyond that is network lag and is given back, from a quota that
-- grows by a fixed gain each action (1 s in long games, 0.2 s in the fastest) up to 7 gains. A page
-- that lies about its think time takes at most the gain per action, as on lichess. The time is
-- taken when the action reached the edge function (its replay of the game isn't the player's).
-- A flag falls once the side's time is past its quota's grace (2 s at most): an action on its way
-- is still taken when its compensated time had not run out.
--
-- Broadcast keys: each player's page signs the actions it broadcasts to the game's watchers (who
-- show them before the database confirms them); the public halves of the keys are on the row.

alter table public.live_games
  add column white_quota_ms integer,
  add column black_quota_ms integer,
  add column white_key text,
  add column black_key text;

/** Lag compensation gained per action (ms): lila's quotaGain, from the game's estimated length (base + 40 actions). */
create function private.lag_gain(g public.live_games) returns integer language sql immutable as $$
  select case when g.base_ms is null then 0 else
    (select case when est >= 180 then 1000 when est <= 15 then 200 else (est / 2 + 10) * 10 end
     from (select (g.base_ms + 40 * (g.inc_ms + g.delay_ms + g.tl_delay_ms)) / 1000 as est) e)
  end
$$;

/** A side's lag quota now (ms): 3 gains to start with. */
create function private.lag_quota(g public.live_games, side smallint) returns integer language sql immutable as $$
  select coalesce(case side when 1 then g.white_quota_ms else g.black_quota_ms end, 3 * private.lag_gain(g))
$$;

/** How far past zero a side's clock may run before its flag falls (ms). */
create function private.flag_grace(g public.live_games, side smallint) returns integer language sql immutable as $$
  select least(2000, private.lag_quota(g, side))
$$;

create or replace function private.rate_game(g public.live_games) returns public.live_games language plpgsql as $$
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
  -- The diffs go on the row the caller writes (once, with the result).
  g.white_diff := private.int_rating(nw.new_r) - private.int_rating(w.rating);
  g.black_diff := private.int_rating(nb.new_r) - private.int_rating(b.rating);
  return g;
end $$;

/** Game g ended (in memory): clocks stopped, offers and claims gone, the result and the ratings. */
create function private.ended(g public.live_games, p_winner smallint, p_termination text, now_ timestamptz)
returns public.live_games language plpgsql as $$
begin
  if g.color_ticking is not null then
    if g.color_ticking = 1 then g.white_ms := greatest(0, private.time_left(g, 1::smallint, now_));
    else g.black_ms := greatest(0, private.time_left(g, 2::smallint, now_)); end if;
  end if;
  g.color_ticking := null;
  g.turn_started_at := now_;
  g.draw_offer := null;
  g.white_claim_at := null;
  g.black_claim_at := null;
  g.white_claim_voluntary := null;
  g.black_claim_voluntary := null;
  g.empty_since := null;
  g.engine_frozen := false;
  g.result := case when p_termination = 'aborted' then '*' when p_winner = 1 then '1-0' when p_winner = 2 then '0-1' else '1/2-1/2' end;
  g.termination := p_termination;
  g.ended_at := now_;
  g.updated_at := now_;
  return private.rate_game(g);
end $$;

/** Write what an action or an end changes on the live row, in one update. */
create function private.store_play(g public.live_games) returns void language plpgsql as $$
begin
  update public.live_games set
    moves = g.moves, ply = g.ply, to_move = g.to_move, draw_offer = g.draw_offer,
    white_ms = g.white_ms, black_ms = g.black_ms, color_ticking = g.color_ticking, turn_started_at = g.turn_started_at,
    active_timelines = g.active_timelines, turn_delay_ms = g.turn_delay_ms,
    white_quota_ms = g.white_quota_ms, black_quota_ms = g.black_quota_ms,
    white_claim_at = g.white_claim_at, black_claim_at = g.black_claim_at,
    white_claim_voluntary = g.white_claim_voluntary, black_claim_voluntary = g.black_claim_voluntary,
    empty_since = g.empty_since, engine_frozen = g.engine_frozen,
    result = g.result, termination = g.termination, ended_at = g.ended_at,
    white_diff = g.white_diff, black_diff = g.black_diff, updated_at = g.updated_at
  where id = g.id;
end $$;

create or replace function private.conclude(gid text, p_winner smallint, p_termination text) returns void language plpgsql as $$
declare g public.live_games;
begin
  select * into g from public.live_games where id = gid for update;
  if g.id is null or g.result is not null then return; end if;
  g := private.ended(g, p_winner, p_termination, clock_timestamp());
  perform private.store_play(g);
  delete from public.active_players where game_id = gid;
  perform private.log_game(g);
end $$;

create or replace function private.evaluate(gid text) returns void language plpgsql as $$
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
    -- Flag fall, after a grace of the side's lag quota (2 s at most): its action may be on the
    -- way, and game_apply_move takes it when its lag-compensated time had not run out.
    if g.color_ticking is not null and private.time_left(g, g.color_ticking, now_) <= -private.flag_grace(g, g.color_ticking) then
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

drop function public.game_apply_move(text, text, text, integer, text, text, text, boolean, smallint, integer, text, jsonb, text);

/**
 * Apply an action the edge function has checked: `p_ply` is the game's length before it (a stale
 * or out-of-turn submission returns the game as it is, for the client to resync). `p_status` is
 * the rules core's verdict after the action (checkmate | stalemate | exiled-white | exiled-black).
 * `p_signals`: what the player's page saw during the turn (private.move_signals); `p_key`: the
 * hash of the position after it (private.position_keys). `p_think_ms`: the player's think time
 * as their page measured it (lag compensation); `p_received_at`: when the action reached the edge
 * function. Everything is written in one update.
 */
create function public.game_apply_move(p_token text, p_tab text, p_id text, p_ply integer, p_lan text, p_san text,
  p_full text, p_lone boolean, p_next_to_move smallint, p_active integer, p_status text, p_signals jsonb default null,
  p_key text default null, p_think_ms integer default null, p_received_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p text := private.pid(p_token);
  g public.live_games;
  mover smallint;
  side smallint;
  now_ timestamptz := clock_timestamp();
  at_ timestamptz;
  entry jsonb;
  elapsed bigint;
  gain integer;
  quota integer;
  comp bigint := 0;
  left_ bigint;
  winner smallint;
  termination text;
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

  entry := jsonb_build_object('lan', p_lan, 'san', p_san, 'full', p_full, 'lone', p_lone);
  g.active_timelines := p_active;
  if g.base_ms is not null then
    if g.ply + 1 >= 3 and g.color_ticking = mover then
      -- The time the action reached the edge function (the server's own clocks; within 5 s of now).
      at_ := case when p_received_at between now_ - interval '5 seconds' and now_ then p_received_at else now_ end;
      elapsed := greatest(0, private.ms(at_ - g.turn_started_at));
      gain := private.lag_gain(g);
      quota := private.lag_quota(g, mover);
      -- A person's lag (not Kairos's: its page searches, and nothing is lost on the way).
      if mover = side and p_think_ms is not null then
        comp := least(quota, greatest(0, elapsed - greatest(0, p_think_ms)));
      end if;
      quota := least(quota + gain - comp, 7 * gain);
      left_ := (case mover when 1 then g.white_ms else g.black_ms end) - greatest(0, elapsed - comp - g.turn_delay_ms);
      if left_ < 0 then
        -- Out of time even with its lag given back: the flag fell before the action came.
        perform private.conclude(p_id, (3 - mover)::smallint, 'time');
        return jsonb_build_object('error', 'over');
      end if;
      left_ := left_ + g.inc_ms;
      if mover = 1 then g.white_quota_ms := quota; else g.black_quota_ms := quota; end if;
    else
      left_ := case mover when 1 then g.white_ms else g.black_ms end;
    end if;
    entry := entry || jsonb_build_object('clk', left_);
    if mover = 1 then g.white_ms := left_; else g.black_ms := left_; end if;
    g.color_ticking := case when g.ply + 1 >= 2 then p_next_to_move end;
    g.turn_started_at := now_;
    g.turn_delay_ms := g.delay_ms + g.tl_delay_ms * p_active;
  end if;
  g.moves := g.moves || jsonb_build_array(entry);
  g.ply := g.ply + 1;
  g.to_move := p_next_to_move;
  -- A move declines the opponent's open draw offer.
  g.draw_offer := case when g.draw_offer = 3 - mover then null else g.draw_offer end;
  g.updated_at := now_;

  if p_status = 'checkmate' then winner := mover; termination := 'checkmate';
  elsif p_status = 'exiled-white' then winner := 2; termination := 'exiled';
  elsif p_status = 'exiled-black' then winner := 1; termination := 'exiled';
  elsif p_status = 'stalemate' then winner := null; termination := 'stalemate';
  end if;
  if termination is not null then g := private.ended(g, winner, termination, now_); end if;
  perform private.store_play(g);
  if termination is not null then
    delete from public.active_players where game_id = p_id;
    perform private.log_game(g);
  end if;
  return jsonb_build_object('ok', true, 'ply', g.ply, 'comp', comp);
end $$;

/** A player's page gives the public half of the key it signs its broadcast actions with. */
create function public.game_key(p_token text, p_id text, p_key text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  if p_key is null or length(p_key) > 200 or p_key ~ '[^A-Za-z0-9_-]' then return; end if;
  select * into g from public.live_games where id = p_id;
  if g.id is null or g.result is not null then return; end if;
  side := private.side(g, private.pid(p_token));
  if side is null or p_key = (case side when 1 then g.white_key else g.black_key end) then return; end if;
  update public.live_games set
    white_key = case side when 1 then p_key else white_key end,
    black_key = case side when 2 then p_key else black_key end
  where id = p_id;
end $$;

revoke all on function private.lag_gain, private.lag_quota, private.flag_grace, private.ended, private.store_play
  from public, anon, authenticated;
revoke all on function public.game_apply_move from public, anon, authenticated;
grant execute on function public.game_apply_move to service_role;
grant execute on function public.game_key to anon, authenticated;
