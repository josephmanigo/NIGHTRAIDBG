-- NIGHTRAID Phase 18: Discord bot dashboard control plane.
-- Apply after database/phase17.sql. This migration is safe to rerun.

create table if not exists public.discord_bot_settings (
  guild_id text primary key,
  disabled_commands text[] not null default '{}',
  module_settings jsonb not null default '{}'::jsonb,
  presence_text text not null default 'NIGHTRAID',
  presence_status text not null default 'online'
    check (presence_status in ('online', 'idle', 'dnd', 'invisible')),
  presence_activity_type text not null default 'WATCHING'
    check (presence_activity_type in ('PLAYING', 'WATCHING', 'LISTENING', 'COMPETING')),
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_custom_commands (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  name text not null check (name ~ '^[a-z0-9_-]{1,32}$'),
  description text not null check (char_length(description) between 1 and 100),
  response text not null check (char_length(response) between 1 and 2000),
  ephemeral boolean not null default false,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, name)
);

create table if not exists public.discord_tracker_profiles (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  channel_id text not null check (channel_id ~ '^[0-9]{16,22}$'),
  platform text not null default 'tiktok' check (platform = 'tiktok'),
  profile_url text not null,
  username text not null,
  live_notifications boolean not null default true,
  upload_notifications boolean not null default true,
  enabled boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guild_id, platform, username)
);

create table if not exists public.discord_bot_status (
  guild_id text primary key,
  bot_user_id text,
  bot_tag text,
  state text not null default 'offline',
  command_count integer not null default 0,
  tracker_count integer not null default 0,
  configuration_updated_at timestamptz,
  last_error text,
  last_seen_at timestamptz not null default now()
);

create index if not exists discord_custom_commands_guild_idx
  on public.discord_custom_commands (guild_id, enabled, name);
create index if not exists discord_tracker_profiles_guild_idx
  on public.discord_tracker_profiles (guild_id, enabled, username);
create unique index if not exists discord_tracker_profiles_identity_idx
  on public.discord_tracker_profiles (guild_id, platform, lower(username));

create or replace function public.set_discord_dashboard_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists discord_bot_settings_updated_at on public.discord_bot_settings;
create trigger discord_bot_settings_updated_at
before update on public.discord_bot_settings
for each row execute function public.set_discord_dashboard_updated_at();

drop trigger if exists discord_custom_commands_updated_at on public.discord_custom_commands;
create trigger discord_custom_commands_updated_at
before update on public.discord_custom_commands
for each row execute function public.set_discord_dashboard_updated_at();

drop trigger if exists discord_tracker_profiles_updated_at on public.discord_tracker_profiles;
create trigger discord_tracker_profiles_updated_at
before update on public.discord_tracker_profiles
for each row execute function public.set_discord_dashboard_updated_at();

alter table public.discord_bot_settings enable row level security;
alter table public.discord_custom_commands enable row level security;
alter table public.discord_tracker_profiles enable row level security;
alter table public.discord_bot_status enable row level security;

revoke all on table public.discord_bot_settings from anon, authenticated;
revoke all on table public.discord_custom_commands from anon, authenticated;
revoke all on table public.discord_tracker_profiles from anon, authenticated;
revoke all on table public.discord_bot_status from anon, authenticated;
grant all on table public.discord_bot_settings to service_role;
grant all on table public.discord_custom_commands to service_role;
grant all on table public.discord_tracker_profiles to service_role;
grant all on table public.discord_bot_status to service_role;

comment on table public.discord_bot_settings is
  'Administrator-managed Discord bot command and presence configuration.';
comment on table public.discord_custom_commands is
  'Dashboard-created Discord slash commands and their safe text responses.';
comment on table public.discord_tracker_profiles is
  'TikTok profiles synchronized from the website dashboard into the Render bot.';
comment on table public.discord_bot_status is
  'Render bot heartbeat and most recently applied dashboard configuration.';
