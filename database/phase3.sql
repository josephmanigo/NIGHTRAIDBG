-- Run this migration once if database/phase1.sql was applied before Phase 3.

alter table public.discord_connections
  add column if not exists encrypted_refresh_token text;

alter table public.clan_applications
  add column if not exists discord_membership_verified boolean,
  add column if not exists discord_onboarding_status text not null default 'NOT_STARTED',
  add column if not exists assigned_discord_roles text[] not null default '{}',
  add column if not exists discord_onboarded_at timestamptz,
  add column if not exists discord_onboarding_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'clan_applications_discord_onboarding_status_check'
  ) then
    alter table public.clan_applications
      add constraint clan_applications_discord_onboarding_status_check
      check (discord_onboarding_status in ('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED'));
  end if;
end $$;

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

alter table public.discord_onboarding_logs enable row level security;

comment on table public.discord_onboarding_logs is
  'Discord onboarding attempts. Access only through authenticated server functions.';
