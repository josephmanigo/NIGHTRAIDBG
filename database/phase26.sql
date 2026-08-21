-- NIGHTRAID Phase 26: idempotent automatic NRT awards.
-- Apply after phase25.sql. Each Discord source event is recorded before its
-- balance change, so gateway replays, concurrent deliveries, and
-- react/unreact/react cycles can never pay the same reward twice.

create table if not exists public.nrt_award_events (
  idempotency_key text primary key,
  award_type text not null check (award_type in ('guess_win', 'post_reaction')),
  user_id text not null,
  amount bigint not null check (amount > 0),
  guild_id text not null,
  channel_id text not null,
  source_message_id text not null,
  game_type text check (game_type is null or game_type in ('number', 'word', 'emoji')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (length(btrim(idempotency_key)) between 1 and 200),
  check (length(btrim(user_id)) > 0),
  check (length(btrim(guild_id)) > 0),
  check (length(btrim(channel_id)) > 0),
  check (length(btrim(source_message_id)) > 0)
);

create index if not exists nrt_award_events_user_created_idx
  on public.nrt_award_events (user_id, created_at desc);

create index if not exists nrt_award_events_source_idx
  on public.nrt_award_events (source_message_id, user_id);

create or replace function public.nrt_award_once(
  p_idempotency_key text,
  p_award_type text,
  p_user_id text,
  p_amount bigint,
  p_guild_id text,
  p_channel_id text,
  p_source_message_id text,
  p_game_type text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted_key text;
  v_existing public.nrt_award_events%rowtype;
  v_balance bigint;
begin
  if p_idempotency_key is null
    or length(btrim(p_idempotency_key)) not between 1 and 200
    or p_award_type is null or p_award_type not in ('guess_win', 'post_reaction')
    or p_user_id is null or length(btrim(p_user_id)) < 1
    or p_amount is null or p_amount <= 0
    or p_guild_id is null or length(btrim(p_guild_id)) < 1
    or p_channel_id is null or length(btrim(p_channel_id)) < 1
    or p_source_message_id is null or length(btrim(p_source_message_id)) < 1
    or (p_game_type is not null and p_game_type not in ('number', 'word', 'emoji'))
    or (p_award_type = 'guess_win' and p_game_type is null)
    or (p_award_type = 'post_reaction' and p_game_type is not null)
  then
    raise exception 'Invalid automatic NRT award.';
  end if;

  insert into public.nrt_award_events (
    idempotency_key,
    award_type,
    user_id,
    amount,
    guild_id,
    channel_id,
    source_message_id,
    game_type,
    metadata
  ) values (
    btrim(p_idempotency_key),
    p_award_type,
    btrim(p_user_id),
    p_amount,
    btrim(p_guild_id),
    btrim(p_channel_id),
    btrim(p_source_message_id),
    p_game_type,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (idempotency_key) do nothing
  returning idempotency_key into v_inserted_key;

  if v_inserted_key is not null then
    insert into public.nrt_balances (user_id, balance)
    values (btrim(p_user_id), p_amount)
    on conflict (user_id) do update
      set balance = public.nrt_balances.balance + excluded.balance,
          updated_at = now()
    returning balance into v_balance;

    return jsonb_build_object(
      'status', 'awarded',
      'award_amount', p_amount,
      'credited_amount', p_amount,
      'balance', v_balance,
      'idempotency_key', btrim(p_idempotency_key)
    );
  end if;

  select * into v_existing
  from public.nrt_award_events
  where idempotency_key = btrim(p_idempotency_key);

  if not found then
    raise exception 'Automatic NRT award conflict could not be resolved.';
  end if;

  if v_existing.award_type is distinct from p_award_type
    or v_existing.user_id is distinct from btrim(p_user_id)
    or v_existing.amount is distinct from p_amount
    or v_existing.guild_id is distinct from btrim(p_guild_id)
    or v_existing.channel_id is distinct from btrim(p_channel_id)
    or v_existing.source_message_id is distinct from btrim(p_source_message_id)
    or v_existing.game_type is distinct from p_game_type
  then
    raise exception 'Automatic NRT award key was reused with conflicting data.';
  end if;

  select balance into v_balance
  from public.nrt_balances
  where user_id = v_existing.user_id;

  if v_balance is null then
    raise exception 'Automatic NRT award exists without a matching balance.';
  end if;

  return jsonb_build_object(
    'status', 'duplicate',
    'award_amount', v_existing.amount,
    'credited_amount', 0,
    'balance', v_balance,
    'idempotency_key', v_existing.idempotency_key
  );
end;
$$;

alter table public.nrt_award_events enable row level security;
revoke all on table public.nrt_award_events from public, anon, authenticated;
grant all on table public.nrt_award_events to service_role;

revoke all on function public.nrt_award_once(text, text, text, bigint, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.nrt_award_once(text, text, text, bigint, text, text, text, text, jsonb)
  to service_role;

comment on table public.nrt_award_events is
  'Immutable once-only source records for automatic NRT game and reaction rewards.';
comment on function public.nrt_award_once(text, text, text, bigint, text, text, text, text, jsonb) is
  'Atomically records one automatic NRT source event and credits its balance exactly once.';
