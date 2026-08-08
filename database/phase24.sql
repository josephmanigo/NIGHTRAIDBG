-- NIGHTRAID Phase 24: persistent interactive Nighty party games.
-- Apply after database/phase23.sql.

create table if not exists public.nighty_party_sessions (
  id uuid primary key,
  guild_id text not null,
  channel_id text not null,
  host_id text not null,
  game_type text not null check (game_type in ('shadow_duel', 'mines', 'crash', 'blackjack_multi')),
  state jsonb not null default '{}'::jsonb,
  status text not null check (status in ('lobby', 'active', 'completed', 'cancelled', 'expired')),
  outcome text,
  version bigint not null default 1,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.nighty_party_players (
  session_id uuid not null references public.nighty_party_sessions(id) on delete cascade,
  user_id text not null,
  wager bigint not null check (wager >= 0),
  payout bigint not null default 0 check (payout >= 0),
  status text not null default 'joined' check (status in ('joined', 'left', 'settled', 'refunded')),
  joined_at timestamptz not null default now(),
  settled_at timestamptz,
  primary key (session_id, user_id)
);

create index if not exists nighty_party_sessions_guild_game_status_idx
  on public.nighty_party_sessions (guild_id, game_type, status, expires_at);
create index if not exists nighty_party_players_user_idx
  on public.nighty_party_players (user_id, session_id);

create or replace function public.nighty_party_snapshot(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select to_jsonb(s) || jsonb_build_object(
    'players', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.joined_at)
      from public.nighty_party_players p
      where p.session_id = s.id
    ), '[]'::jsonb)
  )
  from public.nighty_party_sessions s
  where s.id = p_session_id;
$$;

create or replace function public.nighty_refund_expired_party_sessions(
  p_guild_id text,
  p_user_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_participant public.nighty_party_players%rowtype;
  v_player public.nighty_players%rowtype;
  v_count integer := 0;
begin
  for v_session in
    select s.*
    from public.nighty_party_sessions s
    where (p_guild_id is null or s.guild_id = p_guild_id)
      and (p_user_id is null or exists (
        select 1 from public.nighty_party_players requested_player
        where requested_player.session_id = s.id
          and requested_player.user_id = p_user_id
          and requested_player.status = 'joined'
      ))
      and s.status in ('lobby', 'active')
      and s.expires_at <= now()
    order by s.created_at
  loop
    perform 1 from public.nighty_party_sessions where id = v_session.id for update;
    for v_participant in
      select * from public.nighty_party_players
      where session_id = v_session.id and status = 'joined'
      for update
    loop
      select * into strict v_player
      from public.nighty_players
      where guild_id = v_session.guild_id and user_id = v_participant.user_id
      for update;
      update public.nighty_players
      set balance = balance + v_participant.wager, updated_at = now()
      where guild_id = v_session.guild_id and user_id = v_participant.user_id
      returning * into v_player;
      insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
      values (
        v_session.guild_id, v_participant.user_id, v_participant.wager,
        'game_refund_party', v_session.id::text || ':' || v_participant.user_id, v_player.balance
      );
      update public.nighty_party_players
      set payout = wager, status = 'refunded', settled_at = now()
      where session_id = v_session.id and user_id = v_participant.user_id;
    end loop;
    update public.nighty_party_sessions
    set status = 'expired', outcome = 'expired', resolved_at = now(), version = version + 1
    where id = v_session.id and status in ('lobby', 'active');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function public.nighty_create_party_session(
  p_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_host_id text,
  p_game_type text,
  p_wager bigint,
  p_state jsonb,
  p_status text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_existing uuid;
begin
  if p_game_type not in ('shadow_duel', 'mines', 'crash', 'blackjack_multi')
    or p_wager < 1000 or p_state is null or p_expires_at <= now()
    or p_status not in ('lobby', 'active') then
    raise exception 'Invalid Nighty party session.';
  end if;
  if p_game_type = 'mines' and p_status <> 'active' then
    raise exception 'Nighty mines must start active.';
  end if;

  perform public.nighty_refund_expired_party_sessions(p_guild_id, p_host_id);
  perform public.nighty_ensure_player(p_guild_id, p_host_id, 1000000);
  select s.id into v_existing
  from public.nighty_party_sessions s
  join public.nighty_party_players p on p.session_id = s.id
  where s.guild_id = p_guild_id and s.game_type = p_game_type
    and s.status in ('lobby', 'active') and s.expires_at > now()
    and p.user_id = p_host_id and p.status = 'joined'
  order by s.created_at desc limit 1;
  if found then
    return public.nighty_party_snapshot(v_existing) || jsonb_build_object('mutation_status', 'existing');
  end if;

  select * into strict v_player from public.nighty_players
  where guild_id = p_guild_id and user_id = p_host_id for update;
  if v_player.balance < p_wager then
    return jsonb_build_object(
      'id', p_id, 'guild_id', p_guild_id, 'channel_id', p_channel_id,
      'host_id', p_host_id, 'game_type', p_game_type, 'state', p_state,
      'status', 'rejected', 'mutation_status', 'insufficient_balance',
      'expires_at', p_expires_at, 'balance', v_player.balance, 'players', '[]'::jsonb
    );
  end if;

  update public.nighty_players set balance = balance - p_wager, updated_at = now()
  where guild_id = p_guild_id and user_id = p_host_id returning * into v_player;
  insert into public.nighty_party_sessions (
    id, guild_id, channel_id, host_id, game_type, state, status, expires_at
  ) values (
    p_id, p_guild_id, p_channel_id, p_host_id, p_game_type, p_state, p_status, p_expires_at
  );
  insert into public.nighty_party_players (session_id, user_id, wager)
  values (p_id, p_host_id, p_wager);
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (p_guild_id, p_host_id, -p_wager, 'game_wager_' || p_game_type, p_id::text, v_player.balance);
  return public.nighty_party_snapshot(p_id)
    || jsonb_build_object('mutation_status', 'created', 'balance', v_player.balance);
end;
$$;

create or replace function public.nighty_join_party_session(
  p_session_id uuid,
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_player public.nighty_players%rowtype;
  v_wager bigint;
  v_joined integer;
  v_limit integer;
begin
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  perform public.nighty_refund_expired_party_sessions(v_session.guild_id, p_user_id);
  if v_session.status <> 'lobby' or v_session.expires_at <= now() then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'closed');
  end if;
  if v_session.game_type = 'mines' then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  if v_session.game_type = 'shadow_duel' and coalesce(v_session.state->>'opponentId', '') <> p_user_id then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  if exists (select 1 from public.nighty_party_players where session_id = p_session_id and user_id = p_user_id) then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object(
      'mutation_status', case when exists (
        select 1 from public.nighty_party_players
        where session_id = p_session_id and user_id = p_user_id and status = 'joined'
      ) then 'joined' else 'left' end
    );
  end if;
  v_limit := case when v_session.game_type = 'blackjack_multi' then 4 when v_session.game_type = 'shadow_duel' then 2 else 10 end;
  select count(*) into v_joined from public.nighty_party_players where session_id = p_session_id and status = 'joined';
  if v_joined >= v_limit then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'full');
  end if;
  if exists (
    select 1 from public.nighty_party_sessions s
    join public.nighty_party_players p on p.session_id = s.id
    where s.guild_id = v_session.guild_id and s.game_type = v_session.game_type
      and s.status in ('lobby', 'active') and s.expires_at > now()
      and p.user_id = p_user_id and p.status = 'joined' and s.id <> p_session_id
  ) then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'busy');
  end if;
  v_wager := (v_session.state->>'baseWager')::bigint;
  if v_wager < 1000 then raise exception 'Party session has an invalid wager.'; end if;
  perform public.nighty_ensure_player(v_session.guild_id, p_user_id, 1000000);
  select * into strict v_player from public.nighty_players
  where guild_id = v_session.guild_id and user_id = p_user_id for update;
  if v_player.balance < v_wager then
    return public.nighty_party_snapshot(p_session_id)
      || jsonb_build_object('mutation_status', 'insufficient_balance', 'balance', v_player.balance);
  end if;
  update public.nighty_players set balance = balance - v_wager, updated_at = now()
  where guild_id = v_session.guild_id and user_id = p_user_id returning * into v_player;
  insert into public.nighty_party_players (session_id, user_id, wager)
  values (p_session_id, p_user_id, v_wager);
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (
    v_session.guild_id, p_user_id, -v_wager,
    'game_wager_' || v_session.game_type, p_session_id::text || ':' || p_user_id, v_player.balance
  );
  return public.nighty_party_snapshot(p_session_id)
    || jsonb_build_object('mutation_status', 'joined', 'balance', v_player.balance);
end;
$$;

create or replace function public.nighty_leave_party_session(
  p_session_id uuid,
  p_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_participant public.nighty_party_players%rowtype;
  v_player public.nighty_players%rowtype;
begin
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  if v_session.status <> 'lobby' or v_session.host_id = p_user_id then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  select * into v_participant from public.nighty_party_players
  where session_id = p_session_id and user_id = p_user_id for update;
  if not found or v_participant.status <> 'joined' then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'not_joined');
  end if;
  select * into strict v_player from public.nighty_players
  where guild_id = v_session.guild_id and user_id = p_user_id for update;
  update public.nighty_players set balance = balance + v_participant.wager, updated_at = now()
  where guild_id = v_session.guild_id and user_id = p_user_id returning * into v_player;
  update public.nighty_party_players set payout = wager, status = 'left', settled_at = now()
  where session_id = p_session_id and user_id = p_user_id;
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (
    v_session.guild_id, p_user_id, v_participant.wager,
    'game_refund_party', p_session_id::text || ':leave:' || p_user_id, v_player.balance
  );
  return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'left');
end;
$$;

create or replace function public.nighty_add_party_wager(
  p_session_id uuid,
  p_user_id text,
  p_amount bigint,
  p_action_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_player public.nighty_players%rowtype;
begin
  if p_amount < 1000 or length(p_action_id) < 1 then raise exception 'Invalid additional party wager.'; end if;
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  if v_session.status <> 'active' or v_session.game_type <> 'blackjack_multi' then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'closed');
  end if;
  if not exists (select 1 from public.nighty_party_players where session_id = p_session_id and user_id = p_user_id and status = 'joined') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  if exists (
    select 1 from public.nighty_ledger
    where guild_id = v_session.guild_id and user_id = p_user_id
      and reason = 'game_wager_' || v_session.game_type and reference_id = p_action_id
  ) then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'duplicate');
  end if;
  select * into strict v_player from public.nighty_players
  where guild_id = v_session.guild_id and user_id = p_user_id for update;
  if v_player.balance < p_amount then
    return public.nighty_party_snapshot(p_session_id)
      || jsonb_build_object('mutation_status', 'insufficient_balance', 'balance', v_player.balance);
  end if;
  update public.nighty_players set balance = balance - p_amount, updated_at = now()
  where guild_id = v_session.guild_id and user_id = p_user_id returning * into v_player;
  update public.nighty_party_players set wager = wager + p_amount
  where session_id = p_session_id and user_id = p_user_id;
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values (v_session.guild_id, p_user_id, -p_amount, 'game_wager_' || v_session.game_type, p_action_id, v_player.balance);
  return public.nighty_party_snapshot(p_session_id)
    || jsonb_build_object('mutation_status', 'added', 'balance', v_player.balance);
end;
$$;

create or replace function public.nighty_update_party_session(
  p_session_id uuid,
  p_actor_id text,
  p_state jsonb,
  p_status text,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
begin
  if p_state is null or p_status not in ('lobby', 'active') then raise exception 'Invalid party update.'; end if;
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  if v_session.status not in ('lobby', 'active') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'closed');
  end if;
  if v_session.version <> p_expected_version then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'conflict');
  end if;
  if not exists (select 1 from public.nighty_party_players where session_id = p_session_id and user_id = p_actor_id and status = 'joined') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  update public.nighty_party_sessions set state = p_state, status = p_status, version = version + 1
  where id = p_session_id;
  return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'updated');
end;
$$;

create or replace function public.nighty_complete_party_session(
  p_session_id uuid,
  p_actor_id text,
  p_state jsonb,
  p_outcome text,
  p_payouts jsonb,
  p_daily_key text,
  p_weekly_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_participant public.nighty_party_players%rowtype;
  v_player public.nighty_players%rowtype;
  v_payout jsonb;
  v_amount bigint;
  v_won boolean;
  v_net bigint;
begin
  if p_state is null or jsonb_typeof(p_payouts) <> 'array' or length(p_outcome) < 1 then
    raise exception 'Invalid Nighty party completion.';
  end if;
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  if v_session.status = 'completed' then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'duplicate');
  end if;
  if v_session.status not in ('lobby', 'active') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'closed');
  end if;
  if not exists (select 1 from public.nighty_party_players where session_id = p_session_id and user_id = p_actor_id and status = 'joined') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;

  for v_participant in
    select * from public.nighty_party_players where session_id = p_session_id and status = 'joined' for update
  loop
    select value into v_payout from jsonb_array_elements(p_payouts)
    where value->>'userId' = v_participant.user_id limit 1;
    if v_payout is null then raise exception 'Missing party payout.'; end if;
    v_amount := (v_payout->>'payout')::bigint;
    v_won := coalesce((v_payout->>'won')::boolean, false);
    if v_amount < 0 then raise exception 'Invalid party payout.'; end if;
    select * into strict v_player from public.nighty_players
    where guild_id = v_session.guild_id and user_id = v_participant.user_id for update;
    update public.nighty_players set balance = balance + v_amount, updated_at = now()
    where guild_id = v_session.guild_id and user_id = v_participant.user_id returning * into v_player;
    insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
    values (
      v_session.guild_id, v_participant.user_id, v_amount,
      'game_payout_' || v_session.game_type, p_session_id::text || ':' || v_participant.user_id, v_player.balance
    );
    update public.nighty_party_players
    set payout = v_amount, status = 'settled', settled_at = now()
    where session_id = p_session_id and user_id = v_participant.user_id;
    perform public.nighty_record_game_stats(
      v_session.guild_id, v_participant.user_id, v_session.game_type,
      v_participant.wager, v_amount, v_won
    );
    perform public.nighty_add_mission_progress(
      v_session.guild_id, v_participant.user_id, 'daily', p_daily_key, 'daily_games', 1
    );
    perform public.nighty_add_mission_progress(
      v_session.guild_id, v_participant.user_id, 'weekly', p_weekly_key, 'weekly_games', 1
    );
    v_net := v_amount - v_participant.wager;
    if v_net > 0 then
      perform public.nighty_add_mission_progress(
        v_session.guild_id, v_participant.user_id, 'weekly', p_weekly_key, 'weekly_currency', v_net
      );
    end if;
  end loop;
  update public.nighty_party_sessions
  set state = p_state, status = 'completed', outcome = p_outcome,
    resolved_at = now(), version = version + 1
  where id = p_session_id;
  return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'completed');
end;
$$;

create or replace function public.nighty_cancel_party_session(
  p_session_id uuid,
  p_actor_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.nighty_party_sessions%rowtype;
  v_participant public.nighty_party_players%rowtype;
  v_player public.nighty_players%rowtype;
  v_status text;
begin
  select * into v_session from public.nighty_party_sessions where id = p_session_id for update;
  if not found then return jsonb_build_object('mutation_status', 'missing'); end if;
  if v_session.status not in ('lobby', 'active') then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'duplicate');
  end if;
  if not exists (select 1 from public.nighty_party_players where session_id = p_session_id and user_id = p_actor_id and status = 'joined')
    and not (v_session.game_type = 'shadow_duel' and coalesce(v_session.state->>'opponentId', '') = p_actor_id) then
    return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', 'forbidden');
  end if;
  for v_participant in
    select * from public.nighty_party_players where session_id = p_session_id and status = 'joined' for update
  loop
    select * into strict v_player from public.nighty_players
    where guild_id = v_session.guild_id and user_id = v_participant.user_id for update;
    update public.nighty_players set balance = balance + v_participant.wager, updated_at = now()
    where guild_id = v_session.guild_id and user_id = v_participant.user_id returning * into v_player;
    insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
    values (
      v_session.guild_id, v_participant.user_id, v_participant.wager,
      'game_refund_party', p_session_id::text || ':' || v_participant.user_id, v_player.balance
    );
    update public.nighty_party_players set payout = wager, status = 'refunded', settled_at = now()
    where session_id = p_session_id and user_id = v_participant.user_id;
  end loop;
  v_status := case when p_reason = 'expired' then 'expired' else 'cancelled' end;
  update public.nighty_party_sessions
  set status = v_status, outcome = left(coalesce(nullif(p_reason, ''), v_status), 64),
    resolved_at = now(), version = version + 1
  where id = p_session_id;
  return public.nighty_party_snapshot(p_session_id) || jsonb_build_object('mutation_status', v_status);
end;
$$;

alter table public.nighty_party_sessions enable row level security;
alter table public.nighty_party_players enable row level security;
revoke all on table public.nighty_party_sessions from anon, authenticated;
revoke all on table public.nighty_party_players from anon, authenticated;
grant all on table public.nighty_party_sessions to service_role;
grant all on table public.nighty_party_players to service_role;

revoke all on function public.nighty_party_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.nighty_refund_expired_party_sessions(text, text) from public, anon, authenticated;
revoke all on function public.nighty_create_party_session(uuid, text, text, text, text, bigint, jsonb, text, timestamptz) from public, anon, authenticated;
revoke all on function public.nighty_join_party_session(uuid, text) from public, anon, authenticated;
revoke all on function public.nighty_leave_party_session(uuid, text) from public, anon, authenticated;
revoke all on function public.nighty_add_party_wager(uuid, text, bigint, text) from public, anon, authenticated;
revoke all on function public.nighty_update_party_session(uuid, text, jsonb, text, bigint) from public, anon, authenticated;
revoke all on function public.nighty_complete_party_session(uuid, text, jsonb, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.nighty_cancel_party_session(uuid, text, text) from public, anon, authenticated;
grant execute on function public.nighty_party_snapshot(uuid) to service_role;
grant execute on function public.nighty_refund_expired_party_sessions(text, text) to service_role;
grant execute on function public.nighty_create_party_session(uuid, text, text, text, text, bigint, jsonb, text, timestamptz) to service_role;
grant execute on function public.nighty_join_party_session(uuid, text) to service_role;
grant execute on function public.nighty_leave_party_session(uuid, text) to service_role;
grant execute on function public.nighty_add_party_wager(uuid, text, bigint, text) to service_role;
grant execute on function public.nighty_update_party_session(uuid, text, jsonb, text, bigint) to service_role;
grant execute on function public.nighty_complete_party_session(uuid, text, jsonb, text, jsonb, text, text) to service_role;
grant execute on function public.nighty_cancel_party_session(uuid, text, text) to service_role;

comment on table public.nighty_party_sessions is 'Persistent Shadow Duel, Mines, Crash, and multiplayer Blackjack state.';
comment on table public.nighty_party_players is 'Per-player escrow and duplicate-safe settlement for Nighty party games.';
