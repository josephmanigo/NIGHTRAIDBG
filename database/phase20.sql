-- NIGHTRAID Phase 20: Nighty PvE, accepted PvP wagers, private trades, and market.
-- Apply after database/phase19.sql. This migration is safe to rerun.

alter table public.nighty_players
  add column if not exists battle_available_at timestamptz,
  add column if not exists total_battles bigint not null default 0 check (total_battles >= 0),
  add column if not exists total_battle_wins bigint not null default 0 check (total_battle_wins >= 0);

create table if not exists public.nighty_pvp_challenges (
  id uuid primary key,
  guild_id text not null,
  channel_id text not null,
  challenger_id text not null,
  opponent_id text not null,
  wager bigint not null check (wager > 0),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'declined', 'expired', 'cancelled')),
  winner_id text,
  loser_id text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (challenger_id <> opponent_id)
);

create table if not exists public.nighty_trade_offers (
  id uuid primary key,
  guild_id text not null,
  channel_id text not null,
  seller_id text not null,
  buyer_id text not null,
  character_id text not null check (character_id ~ '^[a-z0-9_]{1,64}$'),
  quantity bigint not null check (quantity > 0),
  price bigint not null check (price > 0),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'declined', 'expired', 'cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check (seller_id <> buyer_id)
);

create table if not exists public.nighty_market_listings (
  id text primary key check (id ~ '^[a-f0-9]{8}$'),
  guild_id text not null,
  seller_id text not null,
  character_id text not null check (character_id ~ '^[a-z0-9_]{1,64}$'),
  quantity bigint not null check (quantity > 0),
  price bigint not null check (price > 0),
  status text not null default 'active'
    check (status in ('active', 'sold', 'cancelled')),
  buyer_id text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists nighty_pvp_pending_idx
  on public.nighty_pvp_challenges (guild_id, opponent_id, status, expires_at);
create index if not exists nighty_trade_pending_idx
  on public.nighty_trade_offers (guild_id, buyer_id, status, expires_at);
create index if not exists nighty_market_active_idx
  on public.nighty_market_listings (guild_id, status, created_at desc);

create or replace function public.nighty_record_battle(
  p_guild_id text,
  p_user_id text,
  p_enemy_id text,
  p_character_id text,
  p_won boolean,
  p_reward bigint,
  p_action_id text,
  p_cooldown_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player public.nighty_players%rowtype;
  v_wait integer := 0;
begin
  if p_reward < 0 or p_cooldown_seconds < 1 then
    raise exception 'Invalid Nighty battle reward or cooldown.';
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
      and reason = 'battle'
      and reference_id = p_action_id
  ) then
    return to_jsonb(v_player) || jsonb_build_object('status', 'duplicate', 'reward', p_reward);
  end if;

  if v_player.battle_available_at is not null and v_player.battle_available_at > now() then
    v_wait := greatest(1, ceil(extract(epoch from (v_player.battle_available_at - now())))::integer);
    return to_jsonb(v_player) || jsonb_build_object(
      'status', 'cooldown', 'cooldown_seconds', v_wait, 'reward', 0
    );
  end if;

  update public.nighty_players
  set
    balance = balance + case when p_won then p_reward else 0 end,
    battle_available_at = now() + make_interval(secs => p_cooldown_seconds),
    total_battles = total_battles + 1,
    total_battle_wins = total_battle_wins + case when p_won then 1 else 0 end,
    updated_at = now()
  where guild_id = p_guild_id and user_id = p_user_id
  returning * into v_player;

  insert into public.nighty_ledger (
    guild_id, user_id, amount, reason, reference_id, balance_after
  ) values (
    p_guild_id,
    p_user_id,
    case when p_won then p_reward else 0 end,
    'battle',
    p_action_id,
    v_player.balance
  );

  return to_jsonb(v_player) || jsonb_build_object(
    'status', 'resolved',
    'cooldown_seconds', p_cooldown_seconds,
    'reward', case when p_won then p_reward else 0 end,
    'enemy_id', p_enemy_id,
    'character_id', p_character_id
  );
end;
$$;

create or replace function public.nighty_create_pvp_challenge(
  p_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_challenger_id text,
  p_opponent_id text,
  p_wager bigint,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenger public.nighty_players%rowtype;
  v_challenge public.nighty_pvp_challenges%rowtype;
begin
  if p_challenger_id = p_opponent_id or p_wager < 1 or p_expires_at <= now() then
    raise exception 'Invalid Nighty PvP challenge.';
  end if;
  select * into strict v_challenger
  from public.nighty_players
  where guild_id = p_guild_id and user_id = p_challenger_id
  for update;
  if not exists (
    select 1 from public.nighty_players
    where guild_id = p_guild_id and user_id = p_opponent_id
  ) then
    raise exception 'The opponent does not have a Nighty profile.';
  end if;
  if v_challenger.balance < p_wager then
    raise exception 'The challenger does not have enough Night Currency.';
  end if;

  insert into public.nighty_pvp_challenges (
    id, guild_id, channel_id, challenger_id, opponent_id, wager, expires_at
  ) values (
    p_id, p_guild_id, p_channel_id, p_challenger_id, p_opponent_id, p_wager, p_expires_at
  ) returning * into v_challenge;
  return to_jsonb(v_challenge);
end;
$$;

create or replace function public.nighty_resolve_pvp_challenge(
  p_challenge_id uuid,
  p_actor_id text,
  p_action text,
  p_winner_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_challenge public.nighty_pvp_challenges%rowtype;
  v_challenger public.nighty_players%rowtype;
  v_opponent public.nighty_players%rowtype;
  v_winner public.nighty_players%rowtype;
  v_loser public.nighty_players%rowtype;
  v_loser_id text;
begin
  select * into v_challenge
  from public.nighty_pvp_challenges
  where id = p_challenge_id
  for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_challenge.status <> 'pending' then
    return to_jsonb(v_challenge) || jsonb_build_object('reason', 'already_resolved');
  end if;
  if p_actor_id <> v_challenge.opponent_id then
    return to_jsonb(v_challenge) || jsonb_build_object('status', 'forbidden', 'reason', 'opponent_only');
  end if;
  if v_challenge.expires_at <= now() then
    update public.nighty_pvp_challenges
    set status = 'expired', resolved_at = now()
    where id = p_challenge_id returning * into v_challenge;
    return to_jsonb(v_challenge);
  end if;
  if p_action = 'decline' then
    update public.nighty_pvp_challenges
    set status = 'declined', resolved_at = now()
    where id = p_challenge_id returning * into v_challenge;
    return to_jsonb(v_challenge);
  end if;
  if p_action <> 'accept' or p_winner_id not in (v_challenge.challenger_id, v_challenge.opponent_id) then
    raise exception 'Invalid Nighty PvP resolution.';
  end if;

  perform 1 from public.nighty_players
  where guild_id = v_challenge.guild_id
    and user_id in (v_challenge.challenger_id, v_challenge.opponent_id)
  order by user_id
  for update;
  select * into strict v_challenger from public.nighty_players
    where guild_id = v_challenge.guild_id and user_id = v_challenge.challenger_id;
  select * into strict v_opponent from public.nighty_players
    where guild_id = v_challenge.guild_id and user_id = v_challenge.opponent_id;
  if v_challenger.balance < v_challenge.wager or v_opponent.balance < v_challenge.wager then
    update public.nighty_pvp_challenges
    set status = 'cancelled', resolved_at = now()
    where id = p_challenge_id returning * into v_challenge;
    return to_jsonb(v_challenge) || jsonb_build_object('reason', 'insufficient_balance');
  end if;

  v_loser_id := case
    when p_winner_id = v_challenge.challenger_id then v_challenge.opponent_id
    else v_challenge.challenger_id
  end;
  update public.nighty_players
  set balance = balance + v_challenge.wager, updated_at = now()
  where guild_id = v_challenge.guild_id and user_id = p_winner_id
  returning * into v_winner;
  update public.nighty_players
  set balance = balance - v_challenge.wager, updated_at = now()
  where guild_id = v_challenge.guild_id and user_id = v_loser_id
  returning * into v_loser;

  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values
    (v_challenge.guild_id, p_winner_id, v_challenge.wager, 'pvp_win', p_challenge_id::text, v_winner.balance),
    (v_challenge.guild_id, v_loser_id, -v_challenge.wager, 'pvp_loss', p_challenge_id::text, v_loser.balance);

  update public.nighty_pvp_challenges
  set status = 'completed', winner_id = p_winner_id, loser_id = v_loser_id, resolved_at = now()
  where id = p_challenge_id returning * into v_challenge;
  return to_jsonb(v_challenge);
end;
$$;

create or replace function public.nighty_create_trade_offer(
  p_id uuid,
  p_guild_id text,
  p_channel_id text,
  p_seller_id text,
  p_buyer_id text,
  p_character_id text,
  p_quantity bigint,
  p_price bigint,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owned bigint := 0;
  v_offer public.nighty_trade_offers%rowtype;
begin
  if p_seller_id = p_buyer_id or p_quantity < 1 or p_price < 1 or p_expires_at <= now() then
    raise exception 'Invalid Nighty trade offer.';
  end if;
  if not exists (select 1 from public.nighty_players where guild_id = p_guild_id and user_id = p_buyer_id) then
    raise exception 'The buyer does not have a Nighty profile.';
  end if;
  select quantity into v_owned from public.nighty_inventory
  where guild_id = p_guild_id and user_id = p_seller_id and character_id = p_character_id;
  if coalesce(v_owned, 0) < p_quantity then
    raise exception 'The seller does not own enough of that character.';
  end if;
  insert into public.nighty_trade_offers (
    id, guild_id, channel_id, seller_id, buyer_id, character_id, quantity, price, expires_at
  ) values (
    p_id, p_guild_id, p_channel_id, p_seller_id, p_buyer_id, p_character_id, p_quantity, p_price, p_expires_at
  ) returning * into v_offer;
  return to_jsonb(v_offer);
end;
$$;

create or replace function public.nighty_resolve_trade_offer(
  p_offer_id uuid,
  p_actor_id text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_offer public.nighty_trade_offers%rowtype;
  v_seller public.nighty_players%rowtype;
  v_buyer public.nighty_players%rowtype;
  v_seller_item public.nighty_inventory%rowtype;
begin
  select * into v_offer from public.nighty_trade_offers where id = p_offer_id for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_offer.status <> 'pending' then return to_jsonb(v_offer) || jsonb_build_object('reason', 'already_resolved'); end if;
  if p_actor_id <> v_offer.buyer_id then
    return to_jsonb(v_offer) || jsonb_build_object('status', 'forbidden', 'reason', 'buyer_only');
  end if;
  if v_offer.expires_at <= now() then
    update public.nighty_trade_offers set status = 'expired', resolved_at = now()
    where id = p_offer_id returning * into v_offer;
    return to_jsonb(v_offer);
  end if;
  if p_action = 'decline' then
    update public.nighty_trade_offers set status = 'declined', resolved_at = now()
    where id = p_offer_id returning * into v_offer;
    return to_jsonb(v_offer);
  end if;
  if p_action <> 'accept' then raise exception 'Invalid Nighty trade action.'; end if;

  perform 1 from public.nighty_players
  where guild_id = v_offer.guild_id and user_id in (v_offer.seller_id, v_offer.buyer_id)
  order by user_id for update;
  select * into strict v_seller from public.nighty_players
    where guild_id = v_offer.guild_id and user_id = v_offer.seller_id;
  select * into strict v_buyer from public.nighty_players
    where guild_id = v_offer.guild_id and user_id = v_offer.buyer_id;
  select * into v_seller_item from public.nighty_inventory
    where guild_id = v_offer.guild_id and user_id = v_offer.seller_id
      and character_id = v_offer.character_id for update;
  if not found or v_seller_item.quantity < v_offer.quantity then
    update public.nighty_trade_offers set status = 'cancelled', resolved_at = now()
    where id = p_offer_id returning * into v_offer;
    return to_jsonb(v_offer) || jsonb_build_object('reason', 'insufficient_inventory');
  end if;
  if v_buyer.balance < v_offer.price then
    update public.nighty_trade_offers set status = 'cancelled', resolved_at = now()
    where id = p_offer_id returning * into v_offer;
    return to_jsonb(v_offer) || jsonb_build_object('reason', 'insufficient_balance');
  end if;

  update public.nighty_inventory set quantity = quantity - v_offer.quantity, updated_at = now()
  where guild_id = v_offer.guild_id and user_id = v_offer.seller_id and character_id = v_offer.character_id;
  insert into public.nighty_inventory (guild_id, user_id, character_id, quantity)
  values (v_offer.guild_id, v_offer.buyer_id, v_offer.character_id, v_offer.quantity)
  on conflict (guild_id, user_id, character_id)
  do update set quantity = public.nighty_inventory.quantity + excluded.quantity, updated_at = now();
  update public.nighty_players set balance = balance + v_offer.price, updated_at = now()
  where guild_id = v_offer.guild_id and user_id = v_offer.seller_id returning * into v_seller;
  update public.nighty_players set balance = balance - v_offer.price, updated_at = now()
  where guild_id = v_offer.guild_id and user_id = v_offer.buyer_id returning * into v_buyer;
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values
    (v_offer.guild_id, v_offer.seller_id, v_offer.price, 'trade_sale', p_offer_id::text, v_seller.balance),
    (v_offer.guild_id, v_offer.buyer_id, -v_offer.price, 'trade_purchase', p_offer_id::text, v_buyer.balance);
  update public.nighty_trade_offers set status = 'completed', resolved_at = now()
  where id = p_offer_id returning * into v_offer;
  return to_jsonb(v_offer);
end;
$$;

create or replace function public.nighty_create_market_listing(
  p_id text,
  p_guild_id text,
  p_seller_id text,
  p_character_id text,
  p_quantity bigint,
  p_price bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.nighty_inventory%rowtype;
  v_listing public.nighty_market_listings%rowtype;
begin
  if p_id !~ '^[a-f0-9]{8}$' or p_quantity < 1 or p_price < 1 then
    raise exception 'Invalid Nighty market listing.';
  end if;
  select * into v_item from public.nighty_inventory
  where guild_id = p_guild_id and user_id = p_seller_id and character_id = p_character_id
  for update;
  if not found or v_item.quantity < p_quantity then
    raise exception 'The seller does not own enough of that character.';
  end if;
  update public.nighty_inventory set quantity = quantity - p_quantity, updated_at = now()
  where guild_id = p_guild_id and user_id = p_seller_id and character_id = p_character_id;
  insert into public.nighty_market_listings (id, guild_id, seller_id, character_id, quantity, price)
  values (p_id, p_guild_id, p_seller_id, p_character_id, p_quantity, p_price)
  returning * into v_listing;
  return to_jsonb(v_listing);
end;
$$;

create or replace function public.nighty_buy_market_listing(
  p_listing_id text,
  p_buyer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.nighty_market_listings%rowtype;
  v_seller public.nighty_players%rowtype;
  v_buyer public.nighty_players%rowtype;
begin
  select * into v_listing from public.nighty_market_listings where id = p_listing_id for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_listing.status <> 'active' then return to_jsonb(v_listing) || jsonb_build_object('reason', 'not_active'); end if;
  if v_listing.seller_id = p_buyer_id then
    return to_jsonb(v_listing) || jsonb_build_object('status', 'forbidden', 'reason', 'own_listing');
  end if;
  perform 1 from public.nighty_players
  where guild_id = v_listing.guild_id and user_id in (v_listing.seller_id, p_buyer_id)
  order by user_id for update;
  select * into strict v_seller from public.nighty_players
    where guild_id = v_listing.guild_id and user_id = v_listing.seller_id;
  select * into strict v_buyer from public.nighty_players
    where guild_id = v_listing.guild_id and user_id = p_buyer_id;
  if v_buyer.balance < v_listing.price then
    return to_jsonb(v_listing) || jsonb_build_object('status', 'cancelled', 'reason', 'insufficient_balance');
  end if;
  update public.nighty_players set balance = balance + v_listing.price, updated_at = now()
  where guild_id = v_listing.guild_id and user_id = v_listing.seller_id returning * into v_seller;
  update public.nighty_players set balance = balance - v_listing.price, updated_at = now()
  where guild_id = v_listing.guild_id and user_id = p_buyer_id returning * into v_buyer;
  insert into public.nighty_inventory (guild_id, user_id, character_id, quantity)
  values (v_listing.guild_id, p_buyer_id, v_listing.character_id, v_listing.quantity)
  on conflict (guild_id, user_id, character_id)
  do update set quantity = public.nighty_inventory.quantity + excluded.quantity, updated_at = now();
  insert into public.nighty_ledger (guild_id, user_id, amount, reason, reference_id, balance_after)
  values
    (v_listing.guild_id, v_listing.seller_id, v_listing.price, 'market_sale', p_listing_id, v_seller.balance),
    (v_listing.guild_id, p_buyer_id, -v_listing.price, 'market_purchase', p_listing_id, v_buyer.balance);
  update public.nighty_market_listings
  set status = 'sold', buyer_id = p_buyer_id, resolved_at = now()
  where id = p_listing_id returning * into v_listing;
  return to_jsonb(v_listing);
end;
$$;

create or replace function public.nighty_cancel_market_listing(
  p_listing_id text,
  p_seller_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_listing public.nighty_market_listings%rowtype;
begin
  select * into v_listing from public.nighty_market_listings where id = p_listing_id for update;
  if not found then return jsonb_build_object('status', 'missing', 'reason', 'missing'); end if;
  if v_listing.status <> 'active' then return to_jsonb(v_listing) || jsonb_build_object('reason', 'not_active'); end if;
  if v_listing.seller_id <> p_seller_id then
    return to_jsonb(v_listing) || jsonb_build_object('status', 'forbidden', 'reason', 'seller_only');
  end if;
  insert into public.nighty_inventory (guild_id, user_id, character_id, quantity)
  values (v_listing.guild_id, p_seller_id, v_listing.character_id, v_listing.quantity)
  on conflict (guild_id, user_id, character_id)
  do update set quantity = public.nighty_inventory.quantity + excluded.quantity, updated_at = now();
  update public.nighty_market_listings set status = 'cancelled', resolved_at = now()
  where id = p_listing_id returning * into v_listing;
  return to_jsonb(v_listing);
end;
$$;

alter table public.nighty_pvp_challenges enable row level security;
alter table public.nighty_trade_offers enable row level security;
alter table public.nighty_market_listings enable row level security;
revoke all on table public.nighty_pvp_challenges from anon, authenticated;
revoke all on table public.nighty_trade_offers from anon, authenticated;
revoke all on table public.nighty_market_listings from anon, authenticated;
grant all on table public.nighty_pvp_challenges to service_role;
grant all on table public.nighty_trade_offers to service_role;
grant all on table public.nighty_market_listings to service_role;

revoke all on function public.nighty_record_battle(text, text, text, text, boolean, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.nighty_create_pvp_challenge(uuid, text, text, text, text, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.nighty_resolve_pvp_challenge(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.nighty_create_trade_offer(uuid, text, text, text, text, text, bigint, bigint, timestamptz) from public, anon, authenticated;
revoke all on function public.nighty_resolve_trade_offer(uuid, text, text) from public, anon, authenticated;
revoke all on function public.nighty_create_market_listing(text, text, text, text, bigint, bigint) from public, anon, authenticated;
revoke all on function public.nighty_buy_market_listing(text, text) from public, anon, authenticated;
revoke all on function public.nighty_cancel_market_listing(text, text) from public, anon, authenticated;
grant execute on function public.nighty_record_battle(text, text, text, text, boolean, bigint, text, integer) to service_role;
grant execute on function public.nighty_create_pvp_challenge(uuid, text, text, text, text, bigint, timestamptz) to service_role;
grant execute on function public.nighty_resolve_pvp_challenge(uuid, text, text, text) to service_role;
grant execute on function public.nighty_create_trade_offer(uuid, text, text, text, text, text, bigint, bigint, timestamptz) to service_role;
grant execute on function public.nighty_resolve_trade_offer(uuid, text, text) to service_role;
grant execute on function public.nighty_create_market_listing(text, text, text, text, bigint, bigint) to service_role;
grant execute on function public.nighty_buy_market_listing(text, text) to service_role;
grant execute on function public.nighty_cancel_market_listing(text, text) to service_role;

comment on table public.nighty_pvp_challenges is 'Accepted Nighty PvP challenges with player-selected Night Currency wagers.';
comment on table public.nighty_trade_offers is 'Private Nighty character sale offers requiring the selected buyer to accept.';
comment on table public.nighty_market_listings is 'Escrow-backed public Nighty character market listings.';
