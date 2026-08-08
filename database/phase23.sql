-- NIGHTRAID Phase 23: allow explicit all-in casino wagers above the numeric bet cap.
-- Apply after database/phase22.sql. The bot still caps ordinary numeric bets at
-- 1,000,000 Night Currency; only the `all` keyword sends a larger wager.

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
  if p_game_type in ('slots', 'coinflip') and p_wager < 1000 then
    raise exception 'Nighty wager must be at least 1,000.';
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
  if p_game_type = 'blackjack' and p_wager < 1000 then
    raise exception 'Nighty blackjack wager must be at least 1,000.';
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

revoke all on function public.nighty_record_game_result(text, text, text, bigint, bigint, boolean, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.nighty_start_game_session(uuid, text, text, text, text, bigint, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.nighty_record_game_result(text, text, text, bigint, bigint, boolean, text, integer, text, text) to service_role;
grant execute on function public.nighty_start_game_session(uuid, text, text, text, text, bigint, jsonb, timestamptz) to service_role;
