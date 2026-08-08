-- NIGHTRAID Phase 21: Nighty slots, coin flip, blackjack, trivia, fishing,
-- dungeon raids, boss fights, and word games.
-- Apply after database/phase20.sql. This migration is safe to rerun.

create table if not exists public.nighty_game_cooldowns (
  guild_id text not null,
  user_id text not null,
  game_type text not null check (game_type ~ '^[a-z_]{1,32}$'),
  available_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id, game_type)
);

create table if not exists public.nighty_game_sessions (
  id uuid primary key,
  guild_id text not null,
  channel_id text not null,
  user_id text not null,
  game_type text not null check (game_type in ('blackjack', 'trivia', 'word')),
  wager bigint not null default 0 check (wager >= 0),
  state jsonb not null default '{}'::jsonb,
  status text not null default 'active'
    check (status in ('active', 'completed', 'expired', 'cancelled')),
  outcome text,
  payout bigint not null default 0 check (payout >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.nighty_game_stats (
  guild_id text not null,
  user_id text not null,
  game_type text not null check (game_type ~ '^[a-z_]{1,32}$'),
  plays bigint not null default 0 check (plays >= 0),
  wins bigint not null default 0 check (wins >= 0),
  total_wagered bigint not null default 0 check (total_wagered >= 0),
  total_paid bigint not null default 0 check (total_paid >= 0),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id, game_type)
);

create index if not exists nighty_game_sessions_active_idx
  on public.nighty_game_sessions (guild_id, user_id, game_type, status, expires_at);
create index if not exists nighty_game_stats_player_idx
  on public.nighty_game_stats (guild_id, user_id, plays desc);

create or replace function public.nighty_record_game_stats(
  p_guild_id text,
  p_user_id text,
  p_game_type text,
  p_wager bigint,
  p_payout bigint,
  p_won boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.nighty_game_stats (
    guild_id, user_id, game_type, plays, wins, total_wagered, total_paid
  ) values (
    p_guild_id, p_user_id, p_game_type, 1, case when p_won then 1 else 0 end, p_wager, p_payout
  )
  on conflict (guild_id, user_id, game_type)
  do update set
    plays = public.nighty_game_stats.plays + 1,
    wins = public.nighty_game_stats.wins + case when p_won then 1 else 0 end,
    total_wagered = public.nighty_game_stats.total_wagered + excluded.total_wagered,
    total_paid = public.nighty_game_stats.total_paid + excluded.total_paid,
    updated_at = now();
end;
$$;

create or replace function public.nighty_record_game_result(
  p_guild_id text,
  p_user_id text,
  p_game_type text,
  p_wager bigint,
  p_payout bigint,
  p_won boolean,
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
  v_available_at timestamptz;
  v_wait integer := 0;
  v_net bigint;
begin
  if p_game_type not in ('slots', 'coinflip', 'fishing', 'dungeon', 'boss')
    or p_wager < 0 or p_payout < 0 or p_cooldown_seconds < 0
    or length(p_action_id) < 1 then
    raise exception 'Invalid Nighty game result.';
  end if;
  if p_game_type in ('slots', 'coinflip') and (p_wager < 1000 or p_wager > 1000000) then
    raise exception 'Nighty wager must be between 1,000 and 1,000,000.';
  end if;
  if p_game_type in ('fishing', 'dungeon', 'boss') and p_wager <> 0 then
    raise exception 'This Nighty game does not accept a wager.';
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
      and reason = 'game_' || p_game_type
      and reference_id = p_action_id
  ) then
    return to_jsonb(v_player) || jsonb_build_object(
      'status', 'duplicate', 'wager', p_wager, 'payout', p_payout, 'net', p_payout - p_wager
    );
  end if;

  select available_at into v_available_at
  from public.nighty_game_cooldowns
  where guild_id = p_guild_id and user_id = p_user_id and game_type = p_game_type
  for update;
  if v_available_at is not null and v_available_at > now() then
    v_wait := greatest(1, ceil(extract(epoch from (v_available_at - now())))::integer);
    return to_jsonb(v_player) || jsonb_build_object(
      'status', 'cooldown', 'cooldown_seconds', v_wait, 'wager', 0, 'payout', 0, 'net', 0
    );
  end if;
  if v_player.balance < p_wager then
    return to_jsonb(v_player) || jsonb_build_object(
      'status', 'insufficient_balance', 'wager', p_wager, 'payout', 0, 'net', 0
    );
  end if;

  v_net := p_payout - p_wager;
  update public.nighty_players
  set balance = balance + v_net, updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;

  if p_cooldown_seconds > 0 then
    insert into public.nighty_game_cooldowns (guild_id, user_id, game_type, available_at)
    values (p_guild_id, p_user_id, p_game_type, now() + make_interval(secs => p_cooldown_seconds))
    on conflict (guild_id, user_id, game_type)
    do update set available_at = excluded.available_at, updated_at = now();
  end if;

  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (p_guild_id, p_user_id, v_net, 'game_' || p_game_type, p_action_id, v_player.balance);
  perform public.nighty_record_game_stats(
    p_guild_id, p_user_id, p_game_type, p_wager, p_payout, p_won
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'daily', p_daily_key, 'daily_games', 1
  );
  perform public.nighty_add_mission_progress(
    p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_games', 1
  );
  if v_net > 0 then
    perform public.nighty_add_mission_progress(
      p_guild_id, p_user_id, 'weekly', p_weekly_key, 'weekly_currency', v_net
    );
  end if;

  return to_jsonb(v_player) || jsonb_build_object(
    'status', 'resolved',
    'cooldown_seconds', p_cooldown_seconds,
    'wager', p_wager,
    'payout', p_payout,
    'net', v_net
  );
end;
$$;

create or replace function public.nighty_start_game_session(
  p_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_user_id text,
  p_game_type text,
  p_wager bigint,
  p_state jsonb,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_session public.nighty_game_sessions%rowtype;
begin
  if p_game_type not in ('blackjack', 'trivia', 'word')
    or p_wager < 0 or p_expires_at <= now() or p_state is null then
    raise exception 'Invalid Nighty game session.';
  end if;
  if p_game_type = 'blackjack' and (p_wager < 1000 or p_wager > 1000000) then
    raise exception 'Nighty blackjack wager must be between 1,000 and 1,000,000.';
  end if;
  if p_game_type in ('trivia', 'word') and p_wager <> 0 then
    raise exception 'This Nighty game does not accept a wager.';
  end if;

  perform public.nighty_ensure_player(p_guild_id, p_user_id, 1000000);
  select * into strict v_player
  from public.nighty_players
  where guild_id = p_guild_id and user_id = p_user_id
  for update;

  update public.nighty_game_sessions
  set status = 'expired', outcome = 'expired', resolved_at = now()
  where guild_id = p_guild_id and user_id = p_user_id and game_type = p_game_type
    and status = 'active' and expires_at <= now();

  select * into v_session
  from public.nighty_game_sessions
  where guild_id = p_guild_id and user_id = p_user_id and game_type = p_game_type
    and status = 'active' and expires_at > now()
  order by created_at desc
  limit 1
  for update;
  if found then
    return to_jsonb(v_session) || jsonb_build_object('start_status', 'existing', 'balance', v_player.balance);
  end if;
  if v_player.balance < p_wager then
    return jsonb_build_object(
      'id', p_id, 'guild_id', p_guild_id, 'channel_id', p_channel_id,
      'user_id', p_user_id, 'game_type', p_game_type, 'wager', p_wager,
      'state', p_state, 'status', 'rejected', 'start_status', 'insufficient_balance',
      'expires_at', p_expires_at, 'balance', v_player.balance
    );
  end if;

  update public.nighty_players
  set balance = balance - p_wager, updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;
  insert into public.nighty_game_sessions (
    id, guild_id, channel_id, user_id, game_type, wager, state, expires_at
  ) values (
    p_id, p_guild_id, p_channel_id, p_user_id, p_game_type, p_wager, p_state, p_expires_at
  ) returning * into v_session;
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (
    p_guild_id, p_user_id, -p_wager, 'game_wager_' || p_game_type, p_id::text, v_player.balance
  );
  return to_jsonb(v_session) || jsonb_build_object('start_status', 'created', 'balance', v_player.balance);
end;
$$;

create or replace function public.nighty_update_game_session(
  p_session_id uuid,
  p_user_id text,
  p_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_game_sessions%rowtype;
begin
  select * into v_session from public.nighty_game_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_session.user_id <> p_user_id then
    return to_jsonb(v_session) || jsonb_build_object('status', 'forbidden', 'reason', 'owner_only');
  end if;
  if v_session.status <> 'active' then
    return to_jsonb(v_session) || jsonb_build_object('reason', 'already_resolved');
  end if;
  if v_session.expires_at <= now() then
    update public.nighty_game_sessions
    set status = 'expired', outcome = 'expired', resolved_at = now()
    where id = p_session_id returning * into v_session;
    return to_jsonb(v_session);
  end if;
  update public.nighty_game_sessions set state = p_state
  where id = p_session_id returning * into v_session;
  return to_jsonb(v_session);
end;
$$;

create or replace function public.nighty_complete_game_session(
  p_session_id uuid,
  p_user_id text,
  p_state jsonb,
  p_outcome text,
  p_payout bigint,
  p_won boolean,
  p_daily_key text,
  p_weekly_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_game_sessions%rowtype;
  v_player public.nighty_players%rowtype;
  v_net bigint;
begin
  if p_payout < 0 or length(p_outcome) < 1 or p_state is null then
    raise exception 'Invalid Nighty game completion.';
  end if;
  select * into v_session from public.nighty_game_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_session.user_id <> p_user_id then
    return to_jsonb(v_session) || jsonb_build_object('status', 'forbidden', 'reason', 'owner_only');
  end if;
  if v_session.status <> 'active' then
    return to_jsonb(v_session) || jsonb_build_object('reason', 'already_resolved');
  end if;
  if v_session.expires_at <= now() then
    update public.nighty_game_sessions
    set status = 'expired', outcome = 'expired', resolved_at = now()
    where id = p_session_id returning * into v_session;
    return to_jsonb(v_session);
  end if;

  select * into strict v_player
  from public.nighty_players
  where guild_id = v_session.guild_id and user_id = v_session.user_id
  for update;
  update public.nighty_players
  set balance = balance + p_payout, updated_at = now()
  where guild_id = v_session.guild_id and user_id = v_session.user_id
  returning * into v_player;
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (
    v_session.guild_id, v_session.user_id, p_payout,
    'game_payout_' || v_session.game_type, p_session_id::text, v_player.balance
  );

  v_net := p_payout - v_session.wager;
  perform public.nighty_record_game_stats(
    v_session.guild_id, v_session.user_id, v_session.game_type,
    v_session.wager, p_payout, p_won
  );
  perform public.nighty_add_mission_progress(
    v_session.guild_id, v_session.user_id, 'daily', p_daily_key, 'daily_games', 1
  );
  perform public.nighty_add_mission_progress(
    v_session.guild_id, v_session.user_id, 'weekly', p_weekly_key, 'weekly_games', 1
  );
  if v_net > 0 then
    perform public.nighty_add_mission_progress(
      v_session.guild_id, v_session.user_id, 'weekly', p_weekly_key, 'weekly_currency', v_net
    );
  end if;

  update public.nighty_game_sessions
  set state = p_state, status = 'completed', outcome = p_outcome,
    payout = p_payout, resolved_at = now()
  where id = p_session_id returning * into v_session;
  return to_jsonb(v_session) || jsonb_build_object('balance', v_player.balance);
end;
$$;

alter table public.nighty_game_cooldowns enable row level security;
alter table public.nighty_game_sessions enable row level security;
alter table public.nighty_game_stats enable row level security;
revoke all on table public.nighty_game_cooldowns from anon, authenticated;
revoke all on table public.nighty_game_sessions from anon, authenticated;
revoke all on table public.nighty_game_stats from anon, authenticated;
grant all on table public.nighty_game_cooldowns to service_role;
grant all on table public.nighty_game_sessions to service_role;
grant all on table public.nighty_game_stats to service_role;

revoke all on function public.nighty_record_game_stats(text, text, text, bigint, bigint, boolean) from public, anon, authenticated;
revoke all on function public.nighty_record_game_result(text, text, text, bigint, bigint, boolean, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.nighty_start_game_session(uuid, text, text, text, text, bigint, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.nighty_update_game_session(uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.nighty_complete_game_session(uuid, text, jsonb, text, bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.nighty_record_game_result(text, text, text, bigint, bigint, boolean, text, integer, text, text) to service_role;
grant execute on function public.nighty_start_game_session(uuid, text, text, text, text, bigint, jsonb, timestamptz) to service_role;
grant execute on function public.nighty_update_game_session(uuid, text, jsonb) to service_role;
grant execute on function public.nighty_complete_game_session(uuid, text, jsonb, text, bigint, boolean, text, text) to service_role;

comment on table public.nighty_game_sessions is 'Escrow-backed Nighty blackjack, trivia, and word-game sessions.';
comment on table public.nighty_game_stats is 'Persistent per-player statistics for all eight Nighty games.';
