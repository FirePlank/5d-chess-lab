-- What the migrations expect of a Supabase database, for PGlite: the schemas and roles, and a
-- small auth schema (users, identities, auth.uid() from the request's JWT subject, which a test
-- sets with `set request.jwt.claim.sub = '<uuid>'`).
create schema extensions;
create role anon; create role authenticated; create role service_role;
create schema auth;
create table auth.users (id uuid primary key, raw_user_meta_data jsonb not null default '{}'::jsonb);
create table auth.identities (user_id uuid not null references auth.users (id), provider text not null, provider_id text not null);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
