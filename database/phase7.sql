-- NIGHTRAID Phase 7: security, abuse prevention, and auditability.
-- Run this once in the Supabase SQL editor after phase6.sql.

create table if not exists public.clan_bans (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text,
  in_game_name text,
  in_game_name_normalized text generated always as (
    case
      when in_game_name is null then null
      else lower(regexp_replace(trim(in_game_name), '\s+', ' ', 'g'))
    end
  ) stored,
  facebook_profile_url text,
  facebook_profile_url_normalized text generated always as (
    case
      when facebook_profile_url is null then null
      else lower(regexp_replace(trim(facebook_profile_url), '/+$', ''))
    end
  ) stored,
  reason text not null check (char_length(trim(reason)) between 2 and 500),
  is_active boolean not null default true,
  banned_by text not null,
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  deactivated_by text,
  check (
    nullif(trim(discord_user_id), '') is not null
    or nullif(trim(in_game_name), '') is not null
    or nullif(trim(facebook_profile_url), '') is not null
  ),
  check (
    (is_active and deactivated_at is null and deactivated_by is null)
    or (not is_active and deactivated_at is not null and deactivated_by is not null)
  )
);

create unique index if not exists clan_bans_active_discord_idx
  on public.clan_bans (discord_user_id)
  where is_active and discord_user_id is not null;

create unique index if not exists clan_bans_active_ign_idx
  on public.clan_bans (in_game_name_normalized)
  where is_active and in_game_name_normalized is not null;

create unique index if not exists clan_bans_active_facebook_idx
  on public.clan_bans (facebook_profile_url_normalized)
  where is_active and facebook_profile_url_normalized is not null;

create table if not exists public.security_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_type text not null check (actor_type in ('APPLICANT', 'ADMIN', 'MESSENGER_ADMIN', 'SYSTEM')),
  actor_id text,
  action text not null check (char_length(action) between 2 and 100),
  application_id uuid references public.clan_applications(id) on delete restrict,
  target_type text,
  target_id text,
  outcome text not null default 'SUCCESS' check (outcome in ('SUCCESS', 'DENIED', 'FAILED')),
  details jsonb not null default '{}',
  ip_address_hash text,
  user_agent_hash text,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists security_audit_logs_created_idx
  on public.security_audit_logs (created_at desc);

create index if not exists security_audit_logs_application_idx
  on public.security_audit_logs (application_id, created_at desc);

create or replace function public.prevent_security_audit_log_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'SECURITY_AUDIT_LOGS_ARE_IMMUTABLE' using errcode = '55000';
end;
$$;

drop trigger if exists security_audit_logs_immutable on public.security_audit_logs;
create trigger security_audit_logs_immutable
before update or delete on public.security_audit_logs
for each row execute function public.prevent_security_audit_log_mutation();

create table if not exists public.rate_limit_buckets (
  key_hash text primary key,
  attempt_count integer not null check (attempt_count >= 0),
  window_started_at timestamptz not null,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists rate_limit_buckets_updated_idx
  on public.rate_limit_buckets (updated_at);

create or replace function public.consume_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_block_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket public.rate_limit_buckets%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry integer;
begin
  if char_length(p_key_hash) < 32
    or p_limit < 1
    or p_window_seconds < 1
    or p_block_seconds < 1 then
    raise exception 'INVALID_RATE_LIMIT_ARGUMENTS' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));

  select * into v_bucket
  from public.rate_limit_buckets
  where key_hash = p_key_hash;

  if not found then
    insert into public.rate_limit_buckets (
      key_hash,
      attempt_count,
      window_started_at,
      blocked_until,
      updated_at
    ) values (p_key_hash, 1, v_now, null, v_now);

    return query select true, greatest(p_limit - 1, 0), 0;
    return;
  end if;

  if v_bucket.blocked_until is not null and v_bucket.blocked_until > v_now then
    v_retry := greatest(1, ceil(extract(epoch from (v_bucket.blocked_until - v_now)))::integer);
    update public.rate_limit_buckets set updated_at = v_now where key_hash = p_key_hash;
    return query select false, 0, v_retry;
    return;
  end if;

  if v_bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then
    update public.rate_limit_buckets
    set attempt_count = 1,
        window_started_at = v_now,
        blocked_until = null,
        updated_at = v_now
    where key_hash = p_key_hash;

    return query select true, greatest(p_limit - 1, 0), 0;
    return;
  end if;

  if v_bucket.attempt_count >= p_limit then
    update public.rate_limit_buckets
    set attempt_count = attempt_count + 1,
        blocked_until = v_now + make_interval(secs => p_block_seconds),
        updated_at = v_now
    where key_hash = p_key_hash;

    return query select false, 0, p_block_seconds;
    return;
  end if;

  update public.rate_limit_buckets
  set attempt_count = attempt_count + 1,
      blocked_until = null,
      updated_at = v_now
  where key_hash = p_key_hash;

  return query select true, greatest(p_limit - v_bucket.attempt_count - 1, 0), 0;
end;
$$;

revoke all on function public.consume_rate_limit(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer, integer) to service_role;

alter table public.clan_bans enable row level security;
alter table public.security_audit_logs enable row level security;
alter table public.rate_limit_buckets enable row level security;

comment on table public.security_audit_logs is
  'Append-only security events. Network identifiers are HMAC hashes, never raw addresses.';
