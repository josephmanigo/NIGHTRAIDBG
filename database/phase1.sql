create extension if not exists pgcrypto;

create table if not exists public.discord_connections (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null unique,
  discord_username text not null,
  discord_avatar text,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.clan_applications (
  id uuid primary key default gen_random_uuid(),
  application_number text not null unique,
  discord_user_id text not null references public.discord_connections(discord_user_id),
  discord_username text not null,
  in_game_name text not null,
  age_group text not null check (age_group in ('UNDER_18', 'AGE_18_OR_ABOVE')),
  sex text not null check (sex in ('Male', 'Female')),
  device text not null check (device in ('PC', 'Mobile')),
  games text[] not null check (cardinality(games) > 0),
  willing_to_use_clan_tag boolean not null,
  play_frequency text not null check (play_frequency in ('Everyday', '3 times a week', 'Once a week')),
  previous_clan text not null,
  previous_clan_leaving_reason text not null,
  facebook_profile_url text not null,
  discovery_source text not null check (discovery_source in ('Facebook', 'TikTok', 'Discord', 'Others')),
  discovery_source_other text,
  already_joined_discord boolean not null,
  discord_membership_verified boolean,
  reason_for_joining text not null,
  consent_accurate boolean not null check (consent_accurate),
  consent_rules boolean not null check (consent_rules),
  consent_false_information boolean not null check (consent_false_information),
  consent_processing boolean not null check (consent_processing),
  status text not null default 'PENDING_REVIEW' check (
    status in ('SUBMITTED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'DISCORD_JOIN_FAILED', 'COMPLETED')
  ),
  reviewed_by text,
  reviewed_at timestamptz,
  decision_reason text,
  discord_onboarding_status text not null default 'NOT_STARTED' check (
    discord_onboarding_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')
  ),
  assigned_discord_roles text[] not null default '{}',
  discord_onboarded_at timestamptz,
  discord_onboarding_error text,
  ai_evaluation_status text not null default 'NOT_STARTED' check (
    ai_evaluation_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')
  ),
  ai_evaluation_error text,
  ai_evaluated_at timestamptz,
  messenger_notification_status text not null default 'NOT_STARTED' check (
    messenger_notification_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED')
  ),
  messenger_notification_error text,
  messenger_notified_at timestamptz,
  messenger_message_ids text[] not null default '{}',
  excel_sync_status text not null default 'NOT_STARTED' check (
    excel_sync_status in ('NOT_STARTED', 'PENDING', 'SYNCED', 'FAILED')
  ),
  excel_synced_at timestamptz,
  excel_sync_error text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(in_game_name) between 2 and 50)
);

create unique index if not exists one_open_application_per_discord
  on public.clan_applications (discord_user_id)
  where status in ('SUBMITTED', 'PROCESSING', 'PENDING_REVIEW', 'APPROVED', 'DISCORD_JOIN_FAILED');

create table if not exists public.admin_users (
  discord_user_id text primary key,
  display_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.discord_onboarding_logs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  discord_user_id text not null,
  guild_id text not null,
  assigned_roles text[] not null default '{}',
  status text not null check (status in ('COMPLETED', 'FAILED')),
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_evaluations (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  recommendation text not null check (recommendation in ('RECOMMENDED', 'MANUAL_REVIEW', 'NOT_RECOMMENDED')),
  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  motivation_score integer not null check (motivation_score between 0 and 25),
  teamwork_score integer not null check (teamwork_score between 0 and 20),
  activity_score integer not null check (activity_score between 0 and 15),
  clan_commitment_score integer not null check (clan_commitment_score between 0 and 20),
  consistency_score integer not null check (consistency_score between 0 and 10),
  communication_score integer not null check (communication_score between 0 and 10),
  strengths text[] not null default '{}',
  concerns text[] not null default '{}',
  summary text not null,
  moderation_flagged boolean not null default false,
  moderation_categories jsonb not null default '{}',
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_evaluations_application_created_idx
  on public.ai_evaluations (application_id, created_at desc);

create table if not exists public.messenger_admins (
  id uuid primary key default gen_random_uuid(),
  facebook_psid text not null unique,
  display_name text not null,
  role text not null default 'REVIEWER' check (role in ('OWNER', 'ADMIN', 'REVIEWER')),
  can_approve boolean not null default false,
  can_reject boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messenger_notification_logs (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  messenger_admin_id uuid references public.messenger_admins(id) on delete set null,
  recipient_psid text not null,
  status text not null check (status in ('COMPLETED', 'FAILED')),
  message_ids text[] not null default '{}',
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists messenger_notification_logs_application_idx
  on public.messenger_notification_logs (application_id, created_at desc);

create table if not exists public.messenger_webhook_events (
  id uuid primary key default gen_random_uuid(),
  external_event_id text not null unique,
  sender_psid text not null,
  event_type text not null,
  payload jsonb not null default '{}',
  processing_status text not null default 'PROCESSING'
    check (processing_status in ('PROCESSING', 'COMPLETED', 'FAILED', 'IGNORED')),
  error_message text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.application_decisions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.clan_applications(id) on delete cascade,
  decision text not null check (decision in ('APPROVED', 'REJECTED')),
  decision_reason text,
  decision_source text not null check (decision_source in ('WEB', 'MESSENGER')),
  decided_by text not null,
  decided_at timestamptz not null default now()
);

create index if not exists application_decisions_application_idx
  on public.application_decisions (application_id, decided_at desc);

create table if not exists public.excel_exports (
  id uuid primary key default gen_random_uuid(),
  export_type text not null check (export_type in ('MASTER_SYNC', 'MANUAL_ALL', 'MANUAL_FILTERED', 'MANUAL_SELECTED')),
  filters jsonb not null default '{}',
  record_count integer not null default 0 check (record_count >= 0),
  generated_by text not null,
  storage_path text,
  status text not null check (status in ('COMPLETED', 'FAILED')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists excel_exports_created_idx
  on public.excel_exports (created_at desc);

create or replace function public.decide_clan_application(
  p_application_id uuid,
  p_decision text,
  p_reason text,
  p_source text,
  p_decided_by text
)
returns setof public.clan_applications
language plpgsql
security definer
set search_path = public
as $$
declare
  decided_application public.clan_applications%rowtype;
begin
  if p_decision not in ('APPROVED', 'REJECTED') then
    raise exception 'INVALID_DECISION' using errcode = '22023';
  end if;
  if p_source not in ('WEB', 'MESSENGER') then
    raise exception 'INVALID_DECISION_SOURCE' using errcode = '22023';
  end if;
  if p_decision = 'REJECTED' and coalesce(length(trim(p_reason)), 0) < 2 then
    raise exception 'REJECTION_REASON_REQUIRED' using errcode = '22023';
  end if;

  update public.clan_applications
  set status = p_decision,
      reviewed_by = p_decided_by,
      reviewed_at = now(),
      decision_reason = case when p_decision = 'REJECTED' then trim(p_reason) else null end,
      updated_at = now()
  where id = p_application_id
    and status in ('SUBMITTED', 'PENDING_REVIEW')
  returning * into decided_application;

  if not found then
    raise exception 'APPLICATION_NOT_PENDING' using errcode = 'P0001';
  end if;

  insert into public.application_decisions (
    application_id,
    decision,
    decision_reason,
    decision_source,
    decided_by
  ) values (
    decided_application.id,
    p_decision,
    decided_application.decision_reason,
    p_source,
    p_decided_by
  );

  return next decided_application;
end;
$$;

revoke all on function public.decide_clan_application(uuid, text, text, text, text) from public, anon, authenticated;
grant execute on function public.decide_clan_application(uuid, text, text, text, text) to service_role;

alter table public.discord_connections enable row level security;
alter table public.clan_applications enable row level security;
alter table public.admin_users enable row level security;
alter table public.discord_onboarding_logs enable row level security;
alter table public.ai_evaluations enable row level security;
alter table public.messenger_admins enable row level security;
alter table public.messenger_notification_logs enable row level security;
alter table public.messenger_webhook_events enable row level security;
alter table public.application_decisions enable row level security;
alter table public.excel_exports enable row level security;

-- Phase 7: security, abuse prevention, and auditability.
create table if not exists public.clan_bans (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text,
  in_game_name text,
  in_game_name_normalized text generated always as (
    case when in_game_name is null then null else lower(regexp_replace(trim(in_game_name), '\s+', ' ', 'g')) end
  ) stored,
  facebook_profile_url text,
  facebook_profile_url_normalized text generated always as (
    case when facebook_profile_url is null then null else lower(regexp_replace(trim(facebook_profile_url), '/+$', '')) end
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
  on public.clan_bans (discord_user_id) where is_active and discord_user_id is not null;
create unique index if not exists clan_bans_active_ign_idx
  on public.clan_bans (in_game_name_normalized) where is_active and in_game_name_normalized is not null;
create unique index if not exists clan_bans_active_facebook_idx
  on public.clan_bans (facebook_profile_url_normalized) where is_active and facebook_profile_url_normalized is not null;

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
create index if not exists security_audit_logs_created_idx on public.security_audit_logs (created_at desc);
create index if not exists security_audit_logs_application_idx on public.security_audit_logs (application_id, created_at desc);

create or replace function public.prevent_security_audit_log_mutation()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'SECURITY_AUDIT_LOGS_ARE_IMMUTABLE' using errcode = '55000';
end;
$$;
drop trigger if exists security_audit_logs_immutable on public.security_audit_logs;
create trigger security_audit_logs_immutable before update or delete on public.security_audit_logs
for each row execute function public.prevent_security_audit_log_mutation();

create table if not exists public.rate_limit_buckets (
  key_hash text primary key,
  attempt_count integer not null check (attempt_count >= 0),
  window_started_at timestamptz not null,
  blocked_until timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists rate_limit_buckets_updated_idx on public.rate_limit_buckets (updated_at);

create or replace function public.consume_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer,
  p_block_seconds integer
)
returns table (allowed boolean, remaining integer, retry_after_seconds integer)
language plpgsql security definer set search_path = public as $$
declare
  v_bucket public.rate_limit_buckets%rowtype;
  v_now timestamptz := clock_timestamp();
  v_retry integer;
begin
  if char_length(p_key_hash) < 32 or p_limit < 1 or p_window_seconds < 1 or p_block_seconds < 1 then
    raise exception 'INVALID_RATE_LIMIT_ARGUMENTS' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  select * into v_bucket from public.rate_limit_buckets where key_hash = p_key_hash;
  if not found then
    insert into public.rate_limit_buckets (key_hash, attempt_count, window_started_at, blocked_until, updated_at)
    values (p_key_hash, 1, v_now, null, v_now);
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
    update public.rate_limit_buckets set attempt_count = 1, window_started_at = v_now, blocked_until = null, updated_at = v_now
    where key_hash = p_key_hash;
    return query select true, greatest(p_limit - 1, 0), 0;
    return;
  end if;
  if v_bucket.attempt_count >= p_limit then
    update public.rate_limit_buckets
    set attempt_count = attempt_count + 1, blocked_until = v_now + make_interval(secs => p_block_seconds), updated_at = v_now
    where key_hash = p_key_hash;
    return query select false, 0, p_block_seconds;
    return;
  end if;
  update public.rate_limit_buckets set attempt_count = attempt_count + 1, blocked_until = null, updated_at = v_now
  where key_hash = p_key_hash;
  return query select true, greatest(p_limit - v_bucket.attempt_count - 1, 0), 0;
end;
$$;
revoke all on function public.consume_rate_limit(text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer, integer) to service_role;

alter table public.clan_bans enable row level security;
alter table public.security_audit_logs enable row level security;
alter table public.rate_limit_buckets enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nightraid-excel',
  'nightraid-excel',
  false,
  52428800,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

comment on table public.clan_applications is
  'NIGHTRAID applications. Access only through authenticated server functions.';
