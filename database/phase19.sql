-- NIGHTRAID Phase 19: Nighty persistent economy, collection, and missions.
-- Apply after database/phase18.sql. This migration is safe to rerun.

create table if not exists public.nighty_players (
  guild_id text not null,
  user_id text not null,
  balance bigint not null default 1000000 check (balance >= 0),
  daily_streak smallint not null default 0 check (daily_streak between 0 and 7),
  last_daily_date date,
  hunt_available_at timestamptz,
  total_hunts bigint not null default 0 check (total_hunts >= 0),
  total_captures bigint not null default 0 check (total_captures >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists public.nighty_inventory (
  guild_id text not null,
  user_id text not null,
  character_id text not null check (character_id ~ '^[a-z0-9_]{1,64}$'),
  quantity bigint not null default 0 check (quantity >= 0),
  first_captured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id, character_id),
  foreign key (guild_id, user_id)
    references public.nighty_players (guild_id, user_id)
    on delete cascade
);

create table if not exists public.nighty_mission_progress (
  guild_id text not null,
  user_id text not null,
  period_type text not null check (period_type in ('daily', 'weekly')),
  period_key text not null,
  mission_id text not null check (mission_id ~ '^[a-z0-9_]{1,64}$'),
  progress bigint not null default 0 check (progress >= 0),
  claimed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id, period_type, period_key, mission_id),
  foreign key (guild_id, user_id)
    references public.nighty_players (guild_id, user_id)
    on delete cascade
);

create table if not exists public.nighty_ledger (
  id bigserial primary key,
  guild_id text not null,
  user_id text not null,
  amount bigint not null,
  reason text not null,
  reference_id text not null,
  balance_after bigint not null check (balance_after >= 0),
  created_at timestamptz not null default now(),
  unique (guild_id, user_id, reason, reference_id),
  foreign key (guild_id, user_id)
    references public.nighty_players (guild_id, user_id)
    on delete cascade
);

create index if not exists nighty_players_balance_idx
  on public.nighty_players (guild_id, balance desc);
create index if not exists nighty_missions_player_period_idx
  on public.nighty_mission_progress (guild_id, user_id, period_type, period_key);
create index if not exists nighty_ledger_player_created_idx
  on public.nighty_ledger (guild_id, user_id, created_at desc);

create or replace function public.nighty_ensure_player(
  p_guild_id text,
  p_user_id text,
  p_starting_balance bigint default 1000000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_is_new boolean := false;
begin
  if p_starting_balance < 0 then
    raise exception 'Starting balance cannot be negative.';
  end if;

  insert into public.nighty_players (guild_id, user_id, balance)
  values (p_guild_id, p_user_id, p_starting_balance)
  on conflict (guild_id, user_id) do nothing
  returning * into v_player;

  v_is_new := found;
  if not v_is_new then
    select * into strict v_player
    from public.nighty_players
    where guild_id = p_guild_id and user_id = p_user_id;
  else
    insert into public.nighty_ledger (
      guild_id, user_id, amount, reason, reference_id, balance_after
    ) values (
      p_guild_id, p_user_id, p_starting_balance, 'new_player', 'initial', p_starting_balance
    ) on conflict do nothing;
  end if;

  return jsonb_build_object(
    'is_new', v_is_new,
    'guild_id', v_player.guild_id,
    'user_id', v_player.user_id,
    'balance', v_player.balance,
    'daily_streak', v_player.daily_streak,
    'last_daily_date', v_player.last_daily_date,
    'hunt_available_at', v_player.hunt_available_at,
    'total_hunts', v_player.total_hunts,
    'total_captures', v_player.total_captures
  );
end;
$$;

create or replace function public.nighty_add_mission_progress(
  p_guild_id text,
  p_user_id text,
  p_period_type text,
  p_period_key text,
  p_mission_id text,
  p_amount bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.nighty_mission_progress (
    guild_id, user_id, period_type, period_key, mission_id, progress
  ) values (
    p_guild_id, p_user_id, p_period_type, p_period_key, p_mission_id, greatest(0, p_amount)
  )
  on conflict (guild_id, user_id, period_type, period_key, mission_id)
  do update set
    progress = public.nighty_mission_progress.progress + excluded.progress,
    updated_at = now();
end;
$$;

create or replace function public.nighty_claim_daily(
  p_guild_id text,
  p_user_id text,
  p_day date,
  p_daily_key text,
  p_weekly_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_streak integer;
  v_reward bigint;
begin
  perform public.nighty_ensure_player(p_guild_id, p_user_id, 1000000);
  select * into strict v_player
  from public.nighty_players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if v_player.last_daily_date = p_day then
    return jsonb_build_object(
      'status', 'already_claimed',
      'guild_id', v_player.guild_id,
      'user_id', v_player.user_id,
      'balance', v_player.balance,
      'daily_streak', v_player.daily_streak,
      'last_daily_date', v_player.last_daily_date,
      'hunt_available_at', v_player.hunt_available_at,
      'total_hunts', v_player.total_hunts,
      'total_captures', v_player.total_captures,
      'reward', 0
    );
  end if;

  v_streak := case
    when v_player.last_daily_date = p_day - 1 then least(7, v_player.daily_streak + 1)
    else 1
  end;
  v_reward := case v_streak
    when 1 then 25000
    when 2 then 50000
    when 3 then 75000
    when 4 then 100000
    when 5 then 150000
    when 6 then 200000
    else 250000
  end;

  update public.nighty_players
  set
    balance = balance + v_reward,
    daily_streak = v_streak,
    last_daily_date = p_day,
    updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;

  insert into public.nighty_ledger (
    guild_id, user_id, amount, reason, reference_id, balance_after
  ) values (
    p_guild_id, p_user_id, v_reward, 'daily', p_day::text, v_player.balance
  ) on conflict do nothing;

  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'daily', p_daily_key, 'daily_claim', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_currency', v_reward
  );

  return jsonb_build_object(
    'status', 'claimed',
    'guild_id', v_player.guild_id,
    'user_id', v_player.user_id,
    'balance', v_player.balance,
    'daily_streak', v_player.daily_streak,
    'last_daily_date', v_player.last_daily_date,
    'hunt_available_at', v_player.hunt_available_at,
    'total_hunts', v_player.total_hunts,
    'total_captures', v_player.total_captures,
    'reward', v_reward
  );
end;
$$;

create or replace function public.nighty_record_hunt(
  p_guild_id text,
  p_user_id text,
  p_character_id text,
  p_reward bigint,
  p_action_id text,
  p_cooldown_seconds integer,
  p_daily_key text,
  p_weekly_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_quantity bigint := 0;
  v_wait integer := 0;
begin
  if p_reward < 0 or p_cooldown_seconds < 1 then
    raise exception 'Invalid Nighty hunt reward or cooldown.';
  end if;
  perform public.nighty_ensure_player(p_guild_id, p_user_id, 1000000);
  select * into strict v_player
  from public.nighty_players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  if exists (
    select 1 from public.nighty_ledger
    where guild_id = p_guild_id
      and user_id = p_user_id
      and reason = 'hunt'
      and reference_id = p_action_id
  ) then
    select quantity into v_quantity
    from public.nighty_inventory
    where guild_id = p_guild_id
      and user_id = p_user_id
      and character_id = p_character_id;
    return jsonb_build_object(
      'status', 'duplicate',
      'cooldown_seconds', 0,
      'guild_id', v_player.guild_id,
      'user_id', v_player.user_id,
      'balance', v_player.balance,
      'daily_streak', v_player.daily_streak,
      'last_daily_date', v_player.last_daily_date,
      'hunt_available_at', v_player.hunt_available_at,
      'total_hunts', v_player.total_hunts,
      'total_captures', v_player.total_captures,
      'reward', p_reward,
      'quantity', coalesce(v_quantity, 0)
    );
  end if;

  if v_player.hunt_available_at is not null and v_player.hunt_available_at > now() then
    v_wait := greatest(1, ceil(extract(epoch from (v_player.hunt_available_at - now())))::integer);
    return jsonb_build_object(
      'status', 'cooldown',
      'cooldown_seconds', v_wait,
      'guild_id', v_player.guild_id,
      'user_id', v_player.user_id,
      'balance', v_player.balance,
      'daily_streak', v_player.daily_streak,
      'last_daily_date', v_player.last_daily_date,
      'hunt_available_at', v_player.hunt_available_at,
      'total_hunts', v_player.total_hunts,
      'total_captures', v_player.total_captures,
      'reward', 0,
      'quantity', 0
    );
  end if;

  update public.nighty_players
  set
    balance = balance + p_reward,
    hunt_available_at = now() + make_interval(secs => p_cooldown_seconds),
    total_hunts = total_hunts + 1,
    total_captures = total_captures + 1,
    updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;

  insert into public.nighty_inventory (guild_id, user_id, character_id, quantity)
  values (p_guild_id, p_user_id, p_character_id, 1)
  on conflict (guild_id, user_id, character_id)
  do update set
    quantity = public.nighty_inventory.quantity + 1,
    updated_at = now()
  returning quantity into v_quantity;

  insert into public.nighty_ledger (
    guild_id, user_id, amount, reason, reference_id, balance_after
  ) values (
    p_guild_id, p_user_id, p_reward, 'hunt', p_action_id, v_player.balance
  );

  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'daily', p_daily_key, 'daily_hunts', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'daily', p_daily_key, 'daily_captures', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_hunts', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_captures', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_currency', p_reward
  );

  return jsonb_build_object(
    'status', 'captured',
    'cooldown_seconds', p_cooldown_seconds,
    'guild_id', v_player.guild_id,
    'user_id', v_player.user_id,
    'balance', v_player.balance,
    'daily_streak', v_player.daily_streak,
    'last_daily_date', v_player.last_daily_date,
    'hunt_available_at', v_player.hunt_available_at,
    'total_hunts', v_player.total_hunts,
    'total_captures', v_player.total_captures,
    'reward', p_reward,
    'quantity', v_quantity
  );
end;
$$;

create or replace function public.nighty_claim_mission(
  p_guild_id text,
  p_user_id text,
  p_period_type text,
  p_period_key text,
  p_mission_id text,
  p_goal bigint,
  p_reward bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_progress public.nighty_mission_progress%rowtype;
begin
  if p_goal < 1 or p_reward < 0 then
    raise exception 'Invalid Nighty mission goal or reward.';
  end if;
  perform public.nighty_ensure_player(p_guild_id, p_user_id, 1000000);
  select * into strict v_player
  from public.nighty_players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  insert into public.nighty_mission_progress (
    guild_id, user_id, period_type, period_key, mission_id, progress
  ) values (
    p_guild_id, p_user_id, p_period_type, p_period_key, p_mission_id, 0
  ) on conflict do nothing;

  select * into strict v_progress
  from public.nighty_mission_progress
  where guild_id = p_guild_id
    and user_id = p_user_id
    and period_type = p_period_type
    and period_key = p_period_key
    and mission_id = p_mission_id
  for update;

  if v_progress.claimed_at is not null then
    return jsonb_build_object(
      'status', 'already_claimed', 'progress', v_progress.progress, 'reward', 0,
      'guild_id', v_player.guild_id, 'user_id', v_player.user_id,
      'balance', v_player.balance, 'daily_streak', v_player.daily_streak,
      'last_daily_date', v_player.last_daily_date,
      'hunt_available_at', v_player.hunt_available_at,
      'total_hunts', v_player.total_hunts, 'total_captures', v_player.total_captures
    );
  end if;
  if v_progress.progress < p_goal then
    return jsonb_build_object(
      'status', 'locked', 'progress', v_progress.progress, 'reward', 0,
      'guild_id', v_player.guild_id, 'user_id', v_player.user_id,
      'balance', v_player.balance, 'daily_streak', v_player.daily_streak,
      'last_daily_date', v_player.last_daily_date,
      'hunt_available_at', v_player.hunt_available_at,
      'total_hunts', v_player.total_hunts, 'total_captures', v_player.total_captures
    );
  end if;

  update public.nighty_mission_progress
  set claimed_at = now(), updated_at = now()
  where guild_id = p_guild_id
    and user_id = p_user_id
    and period_type = p_period_type
    and period_key = p_period_key
    and mission_id = p_mission_id;

  update public.nighty_players
  set balance = balance + p_reward, updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;

  insert into public.nighty_ledger (
    guild_id, user_id, amount, reason, reference_id, balance_after
  ) values (
    p_guild_id,
    p_user_id,
    p_reward,
    'mission',
    p_period_type || ':' || p_period_key || ':' || p_mission_id,
    v_player.balance
  ) on conflict do nothing;

  return jsonb_build_object(
    'status', 'claimed', 'progress', v_progress.progress, 'reward', p_reward,
    'guild_id', v_player.guild_id, 'user_id', v_player.user_id,
    'balance', v_player.balance, 'daily_streak', v_player.daily_streak,
    'last_daily_date', v_player.last_daily_date,
    'hunt_available_at', v_player.hunt_available_at,
    'total_hunts', v_player.total_hunts, 'total_captures', v_player.total_captures
  );
end;
$$;

alter table public.nighty_players enable row level security;
alter table public.nighty_inventory enable row level security;
alter table public.nighty_mission_progress enable row level security;
alter table public.nighty_ledger enable row level security;

revoke all on table public.nighty_players from anon, authenticated;
revoke all on table public.nighty_inventory from anon, authenticated;
revoke all on table public.nighty_mission_progress from anon, authenticated;
revoke all on table public.nighty_ledger from anon, authenticated;
grant all on table public.nighty_players to service_role;
grant all on table public.nighty_inventory to service_role;
grant all on table public.nighty_mission_progress to service_role;
grant all on table public.nighty_ledger to service_role;
grant usage, select on sequence public.nighty_ledger_id_seq to service_role;

revoke all on function public.nighty_ensure_player(text, text, bigint) from public, anon, authenticated;
revoke all on function public.nighty_add_mission_progress(text, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.nighty_claim_daily(text, text, date, text, text) from public, anon, authenticated;
revoke all on function public.nighty_record_hunt(text, text, text, bigint, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.nighty_claim_mission(text, text, text, text, text, bigint, bigint) from public, anon, authenticated;
grant execute on function public.nighty_ensure_player(text, text, bigint) to service_role;
grant execute on function public.nighty_claim_daily(text, text, date, text, text) to service_role;
grant execute on function public.nighty_record_hunt(text, text, text, bigint, text, integer, text, text) to service_role;
grant execute on function public.nighty_claim_mission(text, text, text, text, text, bigint, bigint) to service_role;

comment on table public.nighty_players is 'Persistent Nighty player wallets, streaks, cooldowns, and lifetime totals.';
comment on table public.nighty_inventory is 'NIGHTRAID-themed characters collected through Nighty hunts.';
comment on table public.nighty_mission_progress is 'Daily and weekly Nighty mission progress and claim state.';
comment on table public.nighty_ledger is 'Immutable Night Currency audit ledger used for economy integrity.';
