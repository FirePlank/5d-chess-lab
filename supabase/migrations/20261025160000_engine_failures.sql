-- Kairos never resigns. Its page calls engine_resign only when the search fails in the player's
-- browser (the engine crashed or could not start, after retries): it can't find "no action" in a
-- game that is still on, since the server ends a game at checkmate or stalemate itself. A failure
-- gave the person a win by resignation (game zVqatR, at ply 2); now it aborts the game, whatever
-- its length. (The name stays: pages already loaded call it.)

create or replace function public.engine_resign(p_token text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.live_games; side smallint;
begin
  g := private.lock_game(p_id);
  side := private.my_side(g, p_token);
  if g.result is not null or g.engine_color is null then return; end if;
  perform private.conclude(p_id, null, 'aborted');
end $$;

-- ---------------------------------------------------------------------------------- crash reports

-- When Kairos fails in a browser (its worker can't start, a search traps, an online game's search
-- keeps failing), the page reports it here (static/js/crash.js), and the admins' Discord channel
-- is told: the database asks GitHub to run the `crash-report` workflow (the fair-play token in
-- Vault), which takes the new reports (scripts/crash-report.mjs, with the detector's key) and posts
-- them with the fair-play webhook. A report is at most every 5 minutes per crash run; one waiting
-- longer goes with the next, or with the 15-minute look.
create table private.engine_crashes (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  fp text,
  message text not null,
  context jsonb not null default '{}'::jsonb,
  reported_at timestamptz
);
alter table private.engine_crashes enable row level security;
create index engine_crashes_waiting on private.engine_crashes (at) where reported_at is null;

create table private.crash_runs (at timestamptz primary key default now());
alter table private.crash_runs enable row level security;

/** Ask GitHub to post the waiting crash reports (at most once every 5 minutes). */
create function private.crash_dispatch() returns void language plpgsql security definer set search_path = '' as $$
declare tok text;
begin
  if not exists (select 1 from private.engine_crashes where reported_at is null) then return; end if;
  if exists (select 1 from private.crash_runs where at > clock_timestamp() - interval '5 minutes') then return; end if;
  if to_regnamespace('net') is null or to_regclass('vault.decrypted_secrets') is null then return; end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = ''github_fairplay_token'' limit 1' into tok;
  if tok is null then return; end if;
  insert into private.crash_runs (at) values (clock_timestamp());
  delete from private.crash_runs where at < clock_timestamp() - interval '7 days';
  execute 'select net.http_post(url := $1, body := $2, headers := $3)'
    using 'https://api.github.com/repos/FirePlank/5d-chess-lab/actions/workflows/crash-report.yml/dispatches',
      '{"ref": "main"}'::jsonb,
      jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
        'User-Agent', '5d-chess-lab', 'X-GitHub-Api-Version', '2022-11-28', 'Content-Type', 'application/json');
end $$;

/**
 * A browser reports an engine crash. Anyone may (guests too): at most 5 a browser and 100 in all
 * an hour are kept, the rest dropped.
 */
create function public.engine_crash_report(p_message text, p_context jsonb default '{}'::jsonb, p_fp text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare fp_ text := case when p_fp ~ '^[0-9a-f]{32}$' then p_fp end;
begin
  if p_message is null or length(btrim(p_message)) = 0 then return; end if;
  if (select count(*) from private.engine_crashes where at > clock_timestamp() - interval '1 hour') >= 100 then return; end if;
  if (select count(*) from private.engine_crashes where at > clock_timestamp() - interval '1 hour'
      and (fp = fp_ or (auth.uid() is not null and user_id = auth.uid()))) >= 5 then return; end if;
  insert into private.engine_crashes (user_id, fp, message, context)
  values (auth.uid(), fp_, left(p_message, 1000),
    case when jsonb_typeof(p_context) = 'object' and length(p_context::text) <= 8000 then p_context else '{}'::jsonb end);
  delete from private.engine_crashes where at < clock_timestamp() - interval '90 days';
  perform private.crash_dispatch();
end $$;

/** The crash-report workflow takes the waiting reports (oldest first, 20 at most) and marks them reported. */
create function public.engine_crashes_take(p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare out_ jsonb;
begin
  perform private.detector(p_key);
  with taken as (
    update private.engine_crashes c set reported_at = clock_timestamp()
    where c.id in (select id from private.engine_crashes where reported_at is null order by at limit 20)
    returning c.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'at', t.at, 'message', t.message, 'context', t.context,
    'user', t.user_id, 'name', p.name) order by t.at), '[]'::jsonb)
  into out_ from taken t left join public.profiles p on p.user_id = t.user_id;
  return out_;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('5d-chess-lab-crashes', '*/15 * * * *', 'select private.crash_dispatch()');
  end if;
end $$;

revoke all on function private.crash_dispatch from public, anon, authenticated;
grant execute on function public.engine_crash_report, public.engine_crashes_take to anon, authenticated;
